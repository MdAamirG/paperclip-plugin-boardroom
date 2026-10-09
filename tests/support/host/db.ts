/**
 * The plugin database: PGlite with stub core tables, the plugin's migrations, and a `ctx.db`
 * client that applies the host's rules (statement validators, capability checks, parameter
 * binding and error wrapping).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { CORE_TABLES_SQL } from "../core-tables.js";
import {
  assertIdentifier,
  assertParamsBound,
  splitSqlStatements,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../host-sql-rules.js";
import { requireCapability, viaJson } from "./errors.js";

// Match the host's postgres driver: int8 and numeric come back as strings.
const PARSERS = {
  [types.INT8]: (value: string) => value,
  [types.NUMERIC]: (value: string) => value,
};

// Booting Postgres takes about a second; loading a snapshot takes about 0.2 s. Each distinct
// migration set is built once per test file, then every harness starts from its snapshot.
const baseSnapshots = new Map<string, Promise<Blob>>();

function baseSnapshot(manifest: PaperclipPluginManifestV1, namespace: string, migrationsDir: string): Promise<Blob> {
  const key = JSON.stringify([namespace, migrationsDir, manifest.database?.coreReadTables ?? []]);
  let snapshot = baseSnapshots.get(key);
  if (!snapshot) {
    snapshot = (async () => {
      const base = await PGlite.create({ parsers: PARSERS });
      try {
        await base.exec(CORE_TABLES_SQL);
        await applyMigrations(base, manifest, namespace, migrationsDir);
        return await base.dumpDataDir("none");
      } finally {
        await base.close();
      }
    })();
    baseSnapshots.set(key, snapshot);
  }
  return snapshot;
}

/** A fresh database with core tables and the plugin's migrations applied. */
export async function createDatabase(
  manifest: PaperclipPluginManifestV1,
  namespace: string,
  migrationsDir: string,
): Promise<PGlite> {
  const snapshot = await baseSnapshot(manifest, namespace, migrationsDir);
  return PGlite.create({ parsers: PARSERS, loadDataDir: snapshot });
}

/** Apply a migration directory as the host does: one transaction, host statement rules, filename order. */
export async function applyMigrations(
  pg: PGlite,
  manifest: PaperclipPluginManifestV1,
  namespace: string,
  migrationsDir: string,
): Promise<void> {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${assertIdentifier(namespace, "namespace")}"`);
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const coreReadTables = manifest.database?.coreReadTables ?? [];
  await pg.transaction(async (tx) => {
    for (const file of files) {
      const statements = splitSqlStatements(await readFile(path.join(migrationsDir, file), "utf8"));
      if (statements.length === 0) throw new Error(`Plugin migration ${file} is empty`);
      for (const statement of statements) {
        try {
          validatePluginMigrationStatement(statement, namespace, coreReadTables);
          await tx.exec(statement);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Plugin migration ${file} failed: ${message}`);
        }
      }
    }
  });
}

/**
 * Bind parameters exactly as the host does. The host's `bindSql` replaces every `$n` occurrence
 * with drizzle's `sql` template parameter, so each occurrence becomes its own parameter, and
 * drizzle 0.45 expands a JS array into a parenthesised list: `= ANY($1)` with `[a, b]` runs as
 * `= ANY(($1, $2))` and fails, while `IN $1` runs as `IN ($1, $2)`.
 */
export function bindLikeHost(statement: string, params: readonly unknown[]): { sql: string; params: unknown[] } {
  if (params.length === 0) return { sql: statement, params: [] };
  const bound: unknown[] = [];
  const expand = (value: unknown): string => {
    if (Array.isArray(value)) return `(${value.map(expand).join(", ")})`;
    bound.push(value);
    return `$${bound.length}`;
  };
  let sql = "";
  let cursor = 0;
  for (const match of statement.matchAll(/\$(\d+)/g)) {
    sql += statement.slice(cursor, match.index);
    sql += expand(params[Number(match[1]) - 1]);
    cursor = match.index! + match[0].length;
  }
  sql += statement.slice(cursor);
  return { sql, params: bound };
}

/**
 * Run a validated plugin statement. The host runs plugin SQL through drizzle, which wraps every
 * database error as `Failed query: <sql>\nparams: <params>`; only that message crosses the worker
 * RPC. So the plugin never sees a constraint name or SQLSTATE, and must detect conflicts another
 * way (for example `ON CONFLICT ... DO NOTHING` and the row count).
 */
async function runAsHost<T>(pg: PGlite, statement: string, params: unknown[]) {
  assertParamsBound(statement, params);
  // Params arrive over JSON-RPC, so they are JSON values before the host binds them.
  const bound = bindLikeHost(statement, viaJson(params));
  try {
    return await pg.query<T>(bound.sql, bound.params);
  } catch {
    throw new Error(`Failed query: ${bound.sql}\nparams: ${bound.params.join(",")}`);
  }
}

export function createDbClient(pg: PGlite, manifest: PaperclipPluginManifestV1, namespace: string): PluginDatabaseClient {
  const coreReadTables = manifest.database?.coreReadTables ?? [];
  return {
    namespace,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      requireCapability(manifest, "db.query", "database.namespace.read");
      validatePluginRuntimeQuery(sql, namespace, coreReadTables);
      const result = await runAsHost<T>(pg, sql, params);
      return viaJson(result.rows);
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      requireCapability(manifest, "db.execute", "database.namespace.write");
      validatePluginRuntimeExecute(sql, namespace);
      const result = await runAsHost(pg, sql, params);
      return { rowCount: result.affectedRows ?? 0 };
    },
  };
}
