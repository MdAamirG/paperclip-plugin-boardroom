/**
 * Worker test harness: the SDK test harness plus a real database.
 *
 * `createTestHarness` from the SDK simulates host services in memory, but its `ctx.db` returns no
 * rows, `ctx.streams.emit` is a no-op, session sends never fail, and it has no `onApiRequest`
 * dispatcher. This helper fills those gaps so tests can run the plugin exactly as the host would:
 *
 * - `ctx.db` runs on PGlite (in-memory Postgres) with stub `public` core tables and every file in
 *   `migrations/` applied, under the host-derived namespace name, with the host's runtime rules.
 * - `request(...)` calls `onApiRequest` with the input shape and error mapping of the host route.
 * - `streamEvents` records `ctx.streams.emit` calls (live updates).
 * - `ctx.agents.sessions` is a host-like fake that records sends, creates a queued run row per
 *   send, and can be told to fail sends.
 * - `restart()` reloads the worker on the same database: rows and host records survive, plugin
 *   memory (module state, session callbacks, timers, harness state) does not.
 *
 * Test-only. Never import this from `src/`.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, types } from "@electric-sql/pglite";
import { vi } from "vitest";
import type {
  AgentSession,
  AgentSessionEvent,
  PaperclipPlugin,
  PluginAccessMember,
  PluginApiRequestInput,
  PluginContext,
  PluginDatabaseClient,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk/protocol";
import { createTestHarness, type TestHarness, type TestHarnessLogEntry } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import defaultManifest from "../../src/manifest.js";
import { CORE_TABLES_SQL } from "./core-tables.js";
import {
  assertIdentifier,
  assertParamsBound,
  derivePluginDatabaseNamespace,
  splitSqlStatements,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "./host-sql-rules.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The schema the host creates for this plugin. Migration SQL hard-codes this name. */
export const BOARDROOM_NAMESPACE = derivePluginDatabaseNamespace(
  defaultManifest.id,
  defaultManifest.database?.namespaceSlug,
);

/** The actor the host passes for a board user in local trusted mode. */
export const BOARD_ACTOR: PluginApiRequestInput["actor"] = Object.freeze({
  actorType: "user",
  actorId: "local-board",
  userId: "local-board",
  agentId: null,
  runId: null,
});

export const MEMBER_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface SeededMember {
  memberId: string;
  userId: string;
  companyId: string;
  role: MemberRole;
}

export interface SeededAgent {
  id: string;
  companyId: string;
  name: string;
}

export interface SeededCompany {
  id: string;
  name: string;
  issuePrefix: string;
  agents: SeededAgent[];
  members: Record<MemberRole, SeededMember>;
}

/** Who makes a request: the host's actor shape, a seeded member, or a seeded agent. */
export type ActorInput =
  | PluginApiRequestInput["actor"]
  | Pick<SeededMember, "userId">
  | (Pick<SeededAgent, "id" | "companyId"> & { runId?: string | null });

export interface RequestOptions {
  companyId: string;
  method?: string;
  path?: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  /** Defaults to the local board user (`BOARD_ACTOR`). */
  actor?: ActorInput;
  headers?: Record<string, string>;
}

export interface HarnessResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export interface StreamEventRecord {
  channel: string;
  /** Company the channel was opened for; `null` when emitted without `open` (the host drops those). */
  companyId: string | null;
  event: unknown;
}

export interface SessionSendRecord {
  sessionId: string;
  agentId: string;
  companyId: string;
  prompt: string;
  reason: string | null;
  /** Set when the send succeeded. */
  runId: string | null;
  /** Set when the send was made to fail. */
  error: string | null;
}

export interface CreateHarnessOptions {
  /** Plugin under test. Defaults to `src/worker.ts`, re-imported on every start so module state resets. */
  plugin?: PaperclipPlugin;
  /** Manifest under test. Defaults to `src/manifest.ts`. */
  manifest?: PaperclipPluginManifestV1;
  /** Migration directory. Defaults to the manifest's `database.migrationsDir` in the package root. */
  migrationsDir?: string | URL;
}

export interface BoardroomHarness {
  /** The current plugin context (replaced by `restart()`). */
  readonly ctx: PluginContext;
  /** The current SDK harness, for `getData`, `performAction`, `emit`, `runJob` and friends. */
  readonly sdk: TestHarness;
  /** The plugin instance that is running. */
  readonly plugin: PaperclipPlugin;
  /** Logs from every start, oldest first. */
  readonly logs: TestHarnessLogEntry[];
  /** Activity entries from every start, oldest first (the host keeps them across restarts). */
  readonly activity: TestHarness["activity"];
  /** Every `ctx.streams.emit` call, oldest first. */
  readonly streamEvents: StreamEventRecord[];
  /** Every `ctx.agents.sessions.sendMessage` call, oldest first, failed ones included. */
  readonly sessionSends: SessionSendRecord[];
  /** The raw database, for assertions and fixtures. Bypasses the host's plugin SQL rules. */
  readonly pg: PGlite;

  /** Run raw SQL against the test database (no plugin rules). Rows come back JSON-shaped, as from `ctx.db`. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  seedCompany(input?: { name?: string; issuePrefix?: string; agents?: string[] }): Promise<SeededCompany>;
  seedRun(input: {
    companyId: string;
    agentId: string;
    id?: string;
    status?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
    resultJson?: Record<string, unknown> | null;
  }): Promise<{ id: string }>;
  seedCostEvent(input: {
    companyId: string;
    agentId: string;
    costCents: number;
    runId?: string | null;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    occurredAt?: string;
  }): Promise<{ id: string }>;

  /** Call `onApiRequest` as the host's `/api/plugins/:pluginId/api/*` route does. */
  request<T = unknown>(routeKey: string, options: RequestOptions): Promise<HarnessResponse<T>>;
  /** Deliver a session event to the callback the plugin passed to `sendMessage`. */
  simulateSessionEvent(sessionId: string, event: Omit<AgentSessionEvent, "sessionId">): void;
  /** Make the next `sendMessage` call throw (as the host does when it refuses a wake). */
  failNextSend(error?: Error): void;
  /** Make every `sendMessage` call that matches `predicate` throw, until `clearSendFailures()`. */
  failSends(predicate: (send: SessionSendRecord) => boolean, makeError?: (send: SessionSendRecord) => Error): void;
  clearSendFailures(): void;
  /** Simulate a worker restart on the same database. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

function viaJson<T>(value: T): T {
  // Everything crossing the worker RPC is JSON: Dates become ISO strings, undefined disappears.
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function requireCapability(manifest: PaperclipPluginManifestV1, capability: string): void {
  if (!(manifest.capabilities as readonly string[]).includes(capability)) {
    throw new Error(`Plugin '${manifest.id}' is missing required capability '${capability}'`);
  }
}

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

async function createDatabase(
  manifest: PaperclipPluginManifestV1,
  namespace: string,
  migrationsDir: string,
): Promise<PGlite> {
  const snapshot = await baseSnapshot(manifest, namespace, migrationsDir);
  return PGlite.create({ parsers: PARSERS, loadDataDir: snapshot });
}

async function applyMigrations(
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
  // The host applies all pending migrations in one transaction.
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

function createDbClient(pg: PGlite, manifest: PaperclipPluginManifestV1, namespace: string): PluginDatabaseClient {
  const coreReadTables = manifest.database?.coreReadTables ?? [];
  return {
    namespace,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      requireCapability(manifest, "database.namespace.read");
      validatePluginRuntimeQuery(sql, namespace, coreReadTables);
      assertParamsBound(sql, params);
      const result = await pg.query<T>(sql, viaJson(params));
      return viaJson(result.rows);
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      requireCapability(manifest, "database.namespace.write");
      validatePluginRuntimeExecute(sql, namespace);
      assertParamsBound(sql, params);
      const result = await pg.query(sql, viaJson(params));
      return { rowCount: result.affectedRows ?? 0 };
    },
  };
}

function toRequestActor(actor: ActorInput | undefined): PluginApiRequestInput["actor"] {
  if (!actor) return { ...BOARD_ACTOR };
  if ("actorType" in actor) return { ...actor };
  if ("userId" in actor) {
    return { actorType: "user", actorId: actor.userId, userId: actor.userId, agentId: null, runId: null };
  }
  return { actorType: "agent", actorId: actor.id, userId: null, agentId: actor.id, runId: actor.runId ?? null };
}

function mapThrownError(error: unknown): HarnessResponse<{ error: string }> {
  // A thrown error reaches the host as a JSON-RPC error: only its message and numeric `code`
  // survive. The host maps capability errors to 403, a missing method to 501, the rest to 502.
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const status =
    code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED || code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
      ? 403
      : code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
        ? 501
        : 502;
  return { status, headers: {}, body: { error: message } };
}

async function loadWorkerFresh(): Promise<PaperclipPlugin> {
  // A new module instance per start, so module-level state is lost like in a new worker process.
  vi.resetModules();
  const mod = (await import("../../src/worker.js")) as { default: PaperclipPlugin };
  return mod.default;
}

export async function createBoardroomHarness(options: CreateHarnessOptions = {}): Promise<BoardroomHarness> {
  const manifest = options.manifest ?? defaultManifest;
  if (!manifest.database) throw new Error("The manifest declares no database");
  const namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database.namespaceSlug);
  const migrationsDir =
    options.migrationsDir instanceof URL
      ? fileURLToPath(options.migrationsDir)
      : path.resolve(PACKAGE_ROOT, options.migrationsDir ?? manifest.database.migrationsDir);

  const pg = await createDatabase(manifest, namespace, migrationsDir);

  // Host records. They outlive a plugin restart.
  const companies = new Map<string, Company>();
  const agents = new Map<string, Agent>();
  const accessMembers: PluginAccessMember[] = [];
  const sessions = new Map<string, AgentSession>();
  const pastLogs: TestHarnessLogEntry[] = [];
  const pastActivity: TestHarness["activity"] = [];
  const streamEvents: StreamEventRecord[] = [];
  const sessionSends: SessionSendRecord[] = [];

  // Send failures.
  const oneShotFailures: Error[] = [];
  const failureRules: Array<{
    predicate: (send: SessionSendRecord) => boolean;
    makeError: (send: SessionSendRecord) => Error;
  }> = [];

  // Plugin memory. Replaced on every start.
  let sdk!: TestHarness;
  let plugin!: PaperclipPlugin;
  let sessionCallbacks = new Map<string, (event: AgentSessionEvent) => void>();
  let companyCounter = 0;

  function takeFailure(send: SessionSendRecord): Error | null {
    const oneShot = oneShotFailures.shift();
    if (oneShot) return oneShot;
    const rule = failureRules.find((candidate) => candidate.predicate(send));
    return rule ? rule.makeError(send) : null;
  }

  function installHostFakes(target: TestHarness): void {
    const ctx = target.ctx;
    ctx.db = createDbClient(pg, manifest, namespace);

    const channelCompany = new Map<string, string>();
    ctx.streams = {
      open(channel, companyId) {
        channelCompany.set(channel, companyId);
      },
      emit(channel, event) {
        streamEvents.push({ channel, companyId: channelCompany.get(channel) ?? null, event: viaJson(event) });
      },
      close(channel) {
        channelCompany.delete(channel);
      },
    };

    const callbacks = sessionCallbacks;
    ctx.agents.sessions = {
      async create(agentId, companyId) {
        requireCapability(manifest, "agent.sessions.create");
        const agent = agents.get(agentId);
        if (!companyId || !agent || agent.companyId !== companyId) throw new Error(`Agent not found: ${agentId}`);
        const session: AgentSession = {
          sessionId: randomUUID(),
          agentId,
          companyId,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        sessions.set(session.sessionId, session);
        return { ...session };
      },
      async list(agentId, companyId) {
        requireCapability(manifest, "agent.sessions.list");
        return [...sessions.values()]
          .filter((s) => s.agentId === agentId && s.companyId === companyId && s.status === "active")
          .map((s) => ({ ...s }));
      },
      async sendMessage(sessionId, companyId, opts) {
        requireCapability(manifest, "agent.sessions.send");
        const session = sessions.get(sessionId);
        if (!session || session.status !== "active") throw new Error(`Session not found or closed: ${sessionId}`);
        if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
        const send: SessionSendRecord = {
          sessionId,
          agentId: session.agentId,
          companyId,
          prompt: opts.prompt,
          reason: opts.reason ?? null,
          runId: null,
          error: null,
        };
        sessionSends.push(send);
        const failure = takeFailure(send);
        if (failure) {
          send.error = failure.message;
          throw failure;
        }
        // The host wakes the agent with a heartbeat run; the plugin later reads it from the run table.
        const runId = randomUUID();
        await pg.query(
          "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status) VALUES ($1, $2, $3, 'queued')",
          [runId, companyId, session.agentId],
        );
        send.runId = runId;
        if (opts.onEvent) callbacks.set(sessionId, opts.onEvent);
        return { runId };
      },
      async close(sessionId, companyId) {
        requireCapability(manifest, "agent.sessions.close");
        const session = sessions.get(sessionId);
        if (!session || session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
        session.status = "closed";
        callbacks.delete(sessionId);
      },
    };
  }

  async function start(carriedIssues: Issue[] = []): Promise<void> {
    sessionCallbacks = new Map();
    const next = createTestHarness({ manifest });
    next.seed({
      companies: [...companies.values()],
      agents: [...agents.values()],
      accessMembers,
      issues: carriedIssues,
    });
    installHostFakes(next);
    const nextPlugin = options.plugin ?? (await loadWorkerFresh());
    sdk = next;
    plugin = nextPlugin;
    await nextPlugin.definition.setup(next.ctx);
  }

  async function issuesForCarryOver(): Promise<Issue[]> {
    if (!(manifest.capabilities as readonly string[]).includes("issues.read")) return [];
    const lists = await Promise.all([...companies.keys()].map((companyId) => sdk.ctx.issues.list({ companyId })));
    return lists.flat();
  }

  await start();

  const harness: BoardroomHarness = {
    get ctx() {
      return sdk.ctx;
    },
    get sdk() {
      return sdk;
    },
    get plugin() {
      return plugin;
    },
    get logs() {
      return [...pastLogs, ...sdk.logs];
    },
    get activity() {
      return [...pastActivity, ...sdk.activity];
    },
    streamEvents,
    sessionSends,
    pg,

    async sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
      const result = await pg.query<T>(query, viaJson(params));
      return viaJson(result.rows);
    },

    async seedCompany(input = {}) {
      companyCounter += 1;
      const n = companyCounter;
      const id = randomUUID();
      const name = input.name ?? `Company ${n}`;
      const issuePrefix = input.issuePrefix ?? `C${n}`;
      const now = new Date();
      await pg.query("INSERT INTO public.companies (id, name, issue_prefix) VALUES ($1, $2, $3)", [id, name, issuePrefix]);
      // Test-only partial records: the SDK harness reads ids, company ids, names and statuses.
      const company = { id, name, issuePrefix, status: "active", description: null, createdAt: now, updatedAt: now } as unknown as Company;
      companies.set(id, company);

      const seededAgents: SeededAgent[] = [];
      for (const agentName of input.agents ?? ["CEO", "CTO", "CFO"]) {
        const agentId = randomUUID();
        await pg.query("INSERT INTO public.agents (id, company_id, name) VALUES ($1, $2, $3)", [agentId, id, agentName]);
        const agent = {
          id: agentId,
          companyId: id,
          name: agentName,
          urlKey: agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          role: "general",
          title: null,
          status: "idle",
          reportsTo: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        } as unknown as Agent;
        agents.set(agentId, agent);
        seededAgents.push({ id: agentId, companyId: id, name: agentName });
      }

      const members = {} as Record<MemberRole, SeededMember>;
      for (const role of MEMBER_ROLES) {
        const member: SeededMember = { memberId: randomUUID(), userId: `user-${role}-${n}`, companyId: id, role };
        accessMembers.push({
          id: member.memberId,
          companyId: id,
          principalType: "user",
          principalId: member.userId,
          status: "active",
          membershipRole: role,
          grants: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        members[role] = member;
      }

      sdk.seed({
        companies: [company],
        agents: seededAgents.map((a) => agents.get(a.id)!),
        accessMembers: accessMembers.filter((m) => m.companyId === id),
      });
      return { id, name, issuePrefix, agents: seededAgents, members };
    },

    async seedRun(input) {
      const id = input.id ?? randomUUID();
      await pg.query(
        `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, result_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          input.companyId,
          input.agentId,
          input.status ?? "succeeded",
          input.startedAt ?? null,
          input.finishedAt ?? null,
          input.error ?? null,
          input.resultJson === undefined || input.resultJson === null ? null : JSON.stringify(input.resultJson),
        ],
      );
      return { id };
    },

    async seedCostEvent(input) {
      const id = randomUUID();
      await pg.query(
        `INSERT INTO public.cost_events
           (id, company_id, agent_id, heartbeat_run_id, provider, model, input_tokens, output_tokens, cost_cents, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          input.companyId,
          input.agentId,
          input.runId ?? null,
          input.provider ?? "anthropic",
          input.model ?? "test-model",
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          input.costCents,
          input.occurredAt ?? new Date().toISOString(),
        ],
      );
      return { id };
    },

    async request<T = unknown>(routeKey: string, request: RequestOptions): Promise<HarnessResponse<T>> {
      const handler = plugin.definition.onApiRequest;
      if (!handler) {
        return mapThrownError(
          Object.assign(new Error("handleApiRequest is not implemented by this plugin"), {
            code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
          }),
        ) as HarnessResponse<T>;
      }
      const headers = { ...(request.body !== undefined ? { "content-type": "application/json" } : {}), ...request.headers };
      const input: PluginApiRequestInput = {
        routeKey,
        method: request.method ?? "GET",
        path: request.path ?? "/",
        params: request.params ?? {},
        query: request.query ?? {},
        body: viaJson(request.body ?? null),
        actor: toRequestActor(request.actor),
        companyId: request.companyId,
        headers,
      };
      try {
        const result = viaJson(await handler(viaJson(input)));
        const status =
          Number.isInteger(result?.status) && Number(result.status) >= 200 && Number(result.status) <= 599
            ? Number(result.status)
            : 200;
        return { status, headers: result?.headers ?? {}, body: (status === 204 ? null : (result?.body ?? null)) as T };
      } catch (error) {
        return mapThrownError(error) as HarnessResponse<T>;
      }
    },

    simulateSessionEvent(sessionId, event) {
      const callback = sessionCallbacks.get(sessionId);
      if (!callback) throw new Error(`No active session event callback for session: ${sessionId}`);
      callback(viaJson({ ...event, sessionId }));
    },

    failNextSend(error = new Error("Session send failed")) {
      oneShotFailures.push(error);
    },

    failSends(predicate, makeError = () => new Error("Session send failed")) {
      failureRules.push({ predicate, makeError });
    },

    clearSendFailures() {
      oneShotFailures.length = 0;
      failureRules.length = 0;
    },

    async restart() {
      const carriedIssues = await issuesForCarryOver();
      pastLogs.push(...sdk.logs);
      pastActivity.push(...sdk.activity);
      await start(carriedIssues);
    },

    async close() {
      await pg.close();
    },
  };

  return harness;
}
