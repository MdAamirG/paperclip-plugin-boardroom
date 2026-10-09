/**
 * The Paperclip host's plugin-database rules, mirrored for tests.
 *
 * Ported from `server/src/services/plugin-database.ts` in paperclipai/paperclip (MIT,
 * Copyright (c) 2025 Paperclip AI), as shipped with host release 2026.1005.0. The host does
 * not publish these validators, so the test harness keeps its own copy. If a host release
 * changes the rules, update this file to match; it never ships with the plugin.
 */
import { createHash } from "node:crypto";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;

type SqlRef = { schema: string; table: string; keyword: string };
type QualifiedRefPattern =
  | { pattern: RegExp; groups: "keyword-schema-table" }
  | { pattern: RegExp; groups: "schema-table"; keyword: string };

/** Same rule as the host's `derivePluginDatabaseNamespace`. */
export function derivePluginDatabaseNamespace(pluginKey: string, namespaceSlug?: string): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug =
    (namespaceSlug ?? pluginKey)
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 36) || "plugin";
  return `plugin_${slug}_${hash}`.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH);
}

export function assertIdentifier(value: string, label = "identifier"): string {
  if (!IDENTIFIER_RE.test(value)) throw new Error(`Unsafe SQL ${label}: ${value}`);
  return value;
}

export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = input.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlForKeywordScan(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const patterns: QualifiedRefPattern[] = [
    {
      pattern: /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern:
        /\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern:
        /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "schema-table",
      keyword: "create index",
    },
  ];
  for (const { pattern, ...mapping } of patterns) {
    for (const match of statement.matchAll(pattern)) {
      if (mapping.groups === "keyword-schema-table") {
        refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
      } else {
        refs.push({ keyword: mapping.keyword, schema: match[1]!, table: match[2]! });
      }
    }
  }
  return refs;
}

function assertAllowedPublicRead(ref: SqlRef, allowedCoreReadTables: ReadonlySet<string>): void {
  if (ref.schema !== "public") return;
  if (!allowedCoreReadTables.has(ref.table)) {
    throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
  }
  if (!["from", "join", "references"].includes(ref.keyword)) {
    throw new Error(`Plugin SQL cannot mutate or define objects in public.${ref.table}`);
  }
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
}

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly string[] = [],
): void {
  assertIdentifier(namespace, "namespace");
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) {
    throw new Error("Destructive plugin migrations are not allowed in Phase 1");
  }
  if (/\bdelete\s+from\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot delete data");
  }
  const ddlOrBackfillAllowed =
    /^(create|alter|comment)\b/.test(normalized) ||
    /^(insert\s+into|update)\b/.test(normalized) ||
    (normalized.startsWith("with ") && /\b(insert\s+into|update)\b/.test(normalized));
  if (!ddlOrBackfillAllowed) {
    throw new Error("Plugin migrations may contain DDL or namespace-scoped backfill statements only");
  }
  const refs = extractQualifiedRefs(statement);
  if (refs.length === 0 && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }
  const objectRefKeywords = new Set([
    "alter table",
    "create index",
    "create table",
    "create view",
    "drop table",
    "into",
    "truncate table",
    "update",
  ]);
  if (!refs.some((ref) => objectRefKeywords.has(ref.keyword)) && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }
  const allowed = new Set(coreReadTables);
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowed);
      continue;
    }
    throw new Error(`Plugin SQL references schema "${ref.schema}" outside namespace "${namespace}"`);
  }
}

export function validatePluginRuntimeQuery(
  query: string,
  namespace: string,
  coreReadTables: readonly string[] = [],
): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("Plugin runtime SQL must contain exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("ctx.db.query only allows SELECT statements");
  }
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
  }
  const allowed = new Set(coreReadTables);
  for (const ref of extractQualifiedRefs(statement)) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowed);
      continue;
    }
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
  }
}

export function validatePluginRuntimeExecute(query: string, namespace: string): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("Plugin runtime SQL must contain exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain DDL keywords");
  }
  const refs = extractQualifiedRefs(statement);
  const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
  if (!target || target.schema !== namespace) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
  }
  for (const ref of refs) {
    if (ref.schema !== namespace) {
      throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
    }
  }
}

/** The host binds `$n` placeholders itself and refuses unused or missing parameters. */
export function assertParamsBound(statement: string, params: readonly unknown[] = []): void {
  if (params.length === 0) return;
  const seen = new Set<number>();
  for (const match of statement.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > params.length) {
      throw new Error(`SQL placeholder $${match[1]} has no matching parameter`);
    }
    seen.add(index);
  }
  if (seen.size !== params.length) {
    throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
  }
}
