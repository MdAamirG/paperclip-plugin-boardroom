/**
 * Worker test harness: the SDK test harness plus a host that behaves like the real one.
 *
 * `createTestHarness` from the SDK simulates host services in memory, but its `ctx.db` returns no
 * rows, `ctx.streams.emit` is a no-op, session sends never fail, and it has no `onApiRequest`
 * dispatcher. This harness fills those gaps (one module each under `host/`):
 *
 * - `host/db.ts`: `ctx.db` on PGlite with stub `public` core tables and every file in
 *   `migrations/` applied under the host-derived namespace name; the host's statement rules,
 *   parameter binding (drizzle array expansion) and `Failed query` error wrapping.
 * - `host/routing.ts`: `request(method, path, ...)` goes through the host's scoped API route:
 *   `apiRoutes` matching, route auth, company resolution, company access, then the worker.
 * - `host/sessions.ts`: `ctx.agents.sessions` records sends, creates a queued automation run per
 *   send, and can be told to fail sends.
 * - `host/invocation.ts`: the host's invocation-scope rule. A worker call that names a company is refused
 *   outside an invocation (a session event callback, a job) unless the company has a plugin
 *   configuration row (`saveCompanyConfig`). API requests and `sdk.emit` events are invocations.
 * - `host/streams.ts`: `streamEvents` records `ctx.streams.emit` calls (live updates).
 * - `host/records.ts`: host records that survive `restart()`: companies, agents, members,
 *   issues, issue comments, issue documents and `ctx.state`.
 * - `host/seeding.ts`: `seedCompany`, `seedRun`, `seedCostEvent`.
 *
 * `restart()` reloads the worker on the same database: rows and host records survive, plugin
 * memory (module state, session callbacks, timers) does not.
 *
 * Test-only. Never import this from `src/`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import type { AgentSessionEvent, PaperclipPlugin, PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness, type TestHarnessLogEntry } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import defaultManifest from "../../src/manifest.js";
import { derivePluginDatabaseNamespace } from "./host-sql-rules.js";
import { createDatabase, createDbClient } from "./host/db.js";
import { viaJson } from "./host/errors.js";
import { InvocationGate, runInInvocation } from "./host/invocation.js";
import { HostRecords } from "./host/records.js";
import { dispatchApiRequest, type HarnessResponse, type RequestOptions } from "./host/routing.js";
import { Seeder, type SeedCostEventInput, type SeededCompany, type SeedRunInput } from "./host/seeding.js";
import { SessionHost, type SessionSendRecord } from "./host/sessions.js";
import { installStreams, type StreamEventRecord } from "./host/streams.js";

export { applyMigrations, bindLikeHost } from "./host/db.js";
export { BOARD_ACTOR, type ActorInput, type HarnessResponse, type RequestOptions } from "./host/routing.js";
export {
  MEMBER_ROLES,
  type MemberRole,
  type SeededAgent,
  type SeededCompany,
  type SeededMember,
} from "./host/seeding.js";
export type { SessionSendRecord } from "./host/sessions.js";
export type { StreamEventRecord } from "./host/streams.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The schema the host creates for this plugin. Migration SQL hard-codes this name. */
export const BOARDROOM_NAMESPACE = derivePluginDatabaseNamespace(
  defaultManifest.id,
  defaultManifest.database?.namespaceSlug,
);

export interface CreateHarnessOptions {
  /**
   * Treat every company as having a plugin configuration row, so the host also admits its calls made
   * outside an invocation. Default `false`: a company has no row (Boardroom has no settings), which is
   * the real default. Only tests that are not about the invocation-scope rule should set this.
   */
  everyCompanyConfigured?: boolean;
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
  seedRun(input: SeedRunInput): Promise<{ id: string }>;
  seedCostEvent(input: SeedCostEventInput): Promise<{ id: string }>;

  /**
   * Call the plugin API as the host's `/api/plugins/:pluginId/api/*` route does: `path` is the
   * plugin-local path (for example `/rooms/abc`), matched against the manifest's `apiRoutes`.
   */
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<HarnessResponse<T>>;
  /** Deliver a session event to the callback the plugin passed to `sendMessage`. */
  simulateSessionEvent(sessionId: string, event: Omit<AgentSessionEvent, "sessionId">): void;
  /** Make the next `sendMessage` call throw (as the host does when it refuses a wake). */
  failNextSend(error?: Error): void;
  /** Make every `sendMessage` call that matches `predicate` throw, until `clearSendFailures()`. */
  failSends(predicate: (send: SessionSendRecord) => boolean, makeError?: (send: SessionSendRecord) => Error): void;
  clearSendFailures(): void;
  /**
   * Save a plugin configuration row for the company (`POST /api/plugins/:id/config`). The host then also
   * admits that company's calls made outside an invocation. Boardroom must not depend on it.
   */
  saveCompanyConfig(companyId: string): void;
  /**
   * Whether the host has another invocation active when an out-of-invocation call arrives. Only
   * changes the refusal's wording ("missing, expired, or unknown invocation scope" instead of
   * "company context is required").
   */
  setOtherInvocationActive(active: boolean): void;
  /** Simulate a worker restart on the same database. */
  restart(): Promise<void>;
  close(): Promise<void>;
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

  // Host side: survives a plugin restart.
  const records = new HostRecords(manifest);
  const sessions = new SessionHost(pg, manifest, records.agents);
  const streamEvents: StreamEventRecord[] = [];
  const pastLogs: TestHarnessLogEntry[] = [];
  const pastActivity: TestHarness["activity"] = [];

  // Plugin side: replaced on every start.
  let sdk!: TestHarness;
  let plugin!: PaperclipPlugin;

  const gate = new InvocationGate(manifest);
  gate.everyCompanyConfigured = options.everyCompanyConfigured ?? false;
  const seeder = new Seeder(pg, records, () => sdk);

  async function start(): Promise<void> {
    const next = createTestHarness({ manifest });
    next.seed(records.seedInput());
    next.ctx.db = createDbClient(pg, manifest, namespace);
    installStreams(next.ctx, streamEvents);
    sessions.install(next.ctx);
    records.install(next.ctx);
    gate.install(next.ctx);
    const emitEvent = next.emit.bind(next);
    next.emit = (eventType, payload, base) => runInInvocation(base?.companyId, () => emitEvent(eventType, payload, base));
    const performAction = next.performAction.bind(next);
    next.performAction = (key, params, options) =>
      runInInvocation((params as { companyId?: string } | undefined)?.companyId, () => performAction(key, params, options));
    const nextPlugin = options.plugin ?? (await loadWorkerFresh());
    sdk = next;
    plugin = nextPlugin;
    await nextPlugin.definition.setup(next.ctx);
  }

  await start();

  return {
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
    sessionSends: sessions.sends,
    pg,

    async sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
      const result = await pg.query<T>(query, viaJson(params));
      return viaJson(result.rows);
    },
    seedCompany: (input) => seeder.company(input),
    seedRun: (input) => seeder.run(input),
    seedCostEvent: (input) => seeder.costEvent(input),

    request: (method, requestPath, requestOptions) =>
      dispatchApiRequest({ manifest, plugin, records }, method, requestPath, requestOptions),
    saveCompanyConfig: (companyId) => {
      gate.configured.add(companyId);
    },
    setOtherInvocationActive: (active) => {
      gate.otherInvocationActive = active;
    },
    simulateSessionEvent: (sessionId, event) => sessions.simulateEvent(sessionId, event),
    failNextSend: (error = new Error("Session send failed")) => sessions.failNext(error),
    failSends: (predicate, makeError = () => new Error("Session send failed")) => sessions.failWhen(predicate, makeError),
    clearSendFailures: () => sessions.clearFailures(),

    async restart() {
      await records.captureIssues(sdk);
      pastLogs.push(...sdk.logs);
      pastActivity.push(...sdk.activity);
      await start();
    },

    async close() {
      await pg.close();
    },
  };
}
