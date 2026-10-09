import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

/**
 * Shared plumbing for the data-access functions.
 *
 * Host rules every function follows:
 * - `ctx.db.query` runs one SELECT; `ctx.db.execute` runs one INSERT, UPDATE or DELETE and returns
 *   only a row count, so an insert is followed by a SELECT to read the row back.
 * - Every statement filters on `company_id`: plugin SQL is not company-filtered by the host.
 * - A failed statement reaches the plugin only as drizzle's `Failed query: ...` message, with no
 *   constraint name. Inserts that can conflict use `ON CONFLICT ... DO NOTHING` and report the
 *   conflict as `null` (row count 0) instead of relying on the error.
 * - Parameters are bound by drizzle's `sql` template, which expands a JS array into a list. Never
 *   pass an array; pass a JSON string and unpack it in SQL (see `uuidArrayFromJson`).
 */

export type Db = PluginDatabaseClient;
export type Row = Record<string, unknown>;

export const TABLE_NAMES = ["rooms", "room_participants", "room_messages", "rounds", "turns", "work_links"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Fully qualified table name in the host-provided namespace. */
export function table(db: Db, name: TableName): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db.namespace)) throw new Error(`Unsafe plugin namespace: ${db.namespace}`);
  return `${db.namespace}.${name}`;
}

/** SQL that turns a JSON-array parameter into an ordered `uuid[]`. */
export function uuidArrayFromJson(placeholder: string): string {
  return `ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(${placeholder}::jsonb) WITH ORDINALITY AS a(e, n) ORDER BY n)`;
}

export async function selectOne<T>(db: Db, sql: string, params: unknown[], map: (row: Row) => T): Promise<T | null> {
  const rows = await db.query<Row>(sql, params);
  return rows[0] ? map(rows[0]) : null;
}

export async function selectMany<T>(db: Db, sql: string, params: unknown[], map: (row: Row) => T): Promise<T[]> {
  const rows = await db.query<Row>(sql, params);
  return rows.map(map);
}

// Rows arrive as JSON: timestamps as ISO strings, int4 as numbers, bigint as strings.
export const str = (value: unknown): string => String(value);
export const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
export const num = (value: unknown): number => Number(value);

export function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
