import { definePlugin, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import defaultManifest from "../../src/manifest.js";
import {
  BOARDROOM_NAMESPACE,
  BOARD_ACTOR,
  bindLikeHost,
  createBoardroomHarness,
  type BoardroomHarness,
} from "./harness.js";

const FIXTURE_MIGRATIONS = new URL("../fixtures/migrations/", import.meta.url);
const NOTES_TABLE = `${BOARDROOM_NAMESPACE}.fixture_notes`;

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("PGlite database swap", () => {
  it("uses the host-derived namespace name, not the SDK harness's test_* name", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    expect(BOARDROOM_NAMESPACE).toBe("plugin_boardroom_79f8e138fc");
    expect(harness.ctx.db.namespace).toBe(BOARDROOM_NAMESPACE);
  });

  it("applies the migration directory in filename order and round-trips a row through ctx.db", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany();

    // 0002 adds the `pinned` column, so it must run after 0001.
    const { rowCount } = await harness.ctx.db.execute(
      `INSERT INTO ${NOTES_TABLE} (company_id, body, pinned) VALUES ($1, $2, $3)`,
      [company.id, "hello", true],
    );
    expect(rowCount).toBe(1);

    const rows = await harness.ctx.db.query<{ body: string; pinned: boolean; created_at: string }>(
      `SELECT body, pinned, created_at FROM ${NOTES_TABLE} WHERE company_id = $1`,
      [company.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "hello", pinned: true });
    // Rows cross the worker RPC as JSON, so timestamps arrive as ISO strings.
    expect(typeof rows[0]!.created_at).toBe("string");
  });

  it("can read whitelisted core tables and their seeded rows", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany({ agents: ["CEO", "CTO"] });
    const run = await harness.seedRun({ companyId: company.id, agentId: company.agents[0]!.id, status: "succeeded" });
    await harness.seedCostEvent({ companyId: company.id, agentId: company.agents[0]!.id, runId: run.id, costCents: 42 });

    const agents = await harness.ctx.db.query<{ name: string }>(
      "SELECT name FROM public.agents WHERE company_id = $1 ORDER BY name",
      [company.id],
    );
    expect(agents.map((a) => a.name)).toEqual(["CEO", "CTO"]);

    const costs = await harness.ctx.db.query<{ total: string }>(
      "SELECT sum(cost_cents)::bigint AS total FROM public.cost_events WHERE heartbeat_run_id = $1",
      [run.id],
    );
    // bigint comes back as a string, as with the host's postgres driver.
    expect(costs[0]!.total).toBe("42");
  });

  it("reports a failed statement as the host does: drizzle's 'Failed query' message, no constraint name", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany();
    const id = "6f1d1a52-8d5c-4b8e-9d1e-0a6a2a1f9b11";
    const insert = `INSERT INTO ${NOTES_TABLE} (id, company_id, body) VALUES ($1, $2, $3)`;
    await harness.ctx.db.execute(insert, [id, company.id, "first"]);
    const error = await harness.ctx.db.execute(insert, [id, company.id, "again"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Failed query: ${insert}\nparams: ${id},${company.id},again`);
    expect((error as Error).message).not.toMatch(/duplicate key|fixture_notes_pkey/);
  });

  it("refuses a runtime CREATE TABLE", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    await expect(
      harness.ctx.db.execute(`CREATE TABLE ${BOARDROOM_NAMESPACE}.sneaky (id int)`),
    ).rejects.toThrow(/only allows INSERT, UPDATE, or DELETE/);
    await expect(
      harness.ctx.db.query(`CREATE TABLE ${BOARDROOM_NAMESPACE}.sneaky (id int)`),
    ).rejects.toThrow(/only allows SELECT/);
  });

  it("refuses a write outside the plugin namespace", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany();
    await expect(
      harness.ctx.db.execute("UPDATE public.agents SET name = 'x' WHERE company_id = $1", [company.id]),
    ).rejects.toThrow(/target must be inside plugin namespace/);
    const agents = await harness.sql<{ name: string }>("SELECT name FROM public.agents WHERE company_id = $1", [company.id]);
    expect(agents.every((a) => a.name !== "x")).toBe(true);
  });

  it("refuses a non-SELECT query", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany();
    await expect(
      harness.ctx.db.query(`DELETE FROM ${NOTES_TABLE} WHERE company_id = $1`, [company.id]),
    ).rejects.toThrow(/only allows SELECT/);
  });

  it("refuses a read of a core table the manifest does not whitelist", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    await expect(harness.ctx.db.query("SELECT id FROM public.issues")).rejects.toThrow(/not whitelisted/);
  });

  it("rejects a migration that writes outside the namespace", async () => {
    await expect(
      createBoardroomHarness({ migrationsDir: new URL("../fixtures/bad-migrations/", import.meta.url) }),
    ).rejects.toThrow(/cannot mutate or define objects in public\.agents|not whitelisted/);
  });
});

describe("seed helpers", () => {
  it("seeds a company with agents and one member per role into the SDK harness", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany({ agents: ["CEO"] });

    const members = await harness.ctx.access.members.list({ companyId: company.id });
    // One member per role, plus the local board user (an owner in every company, as at the host).
    expect(members.map((m) => m.membershipRole).sort()).toEqual(["admin", "operator", "owner", "owner", "viewer"]);
    expect(members.filter((m) => m.principalId === "local-board").map((m) => m.membershipRole)).toEqual(["owner"]);
    expect(company.members.viewer.role).toBe("viewer");

    const agents = await harness.ctx.agents.list({ companyId: company.id });
    expect(agents.map((a) => a.name)).toEqual(["CEO"]);
  });

  it("keeps companies apart", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const a = await harness.seedCompany({ agents: ["A1"] });
    const b = await harness.seedCompany({ agents: ["B1", "B2"] });
    expect(a.id).not.toBe(b.id);
    expect((await harness.ctx.agents.list({ companyId: b.id })).map((x) => x.name).sort()).toEqual(["B1", "B2"]);
  });
});

describe("request()", () => {
  type Route = NonNullable<PaperclipPluginManifestV1["apiRoutes"]>[number];
  const route = (routeKey: string, method: Route["method"], path: string, extra: Partial<Route> = {}): Route => ({
    routeKey,
    method,
    path,
    auth: "board",
    capability: "api.routes.register",
    ...extra,
  });
  const ROUTES: Route[] = [
    route("rooms.list", "GET", "/rooms", { companyResolution: { from: "query", key: "companyId" } }),
    route("rooms.create", "POST", "/rooms", { companyResolution: { from: "body", key: "companyId" } }),
    route("rooms.get", "GET", "/rooms/:roomId", { companyResolution: { from: "query", key: "companyId" } }),
    route("issue.touch", "POST", "/issues/:issueId/touch", {
      auth: "board-or-agent",
      companyResolution: { from: "issue", param: "issueId" },
    }),
    route("agent.ping", "POST", "/ping", { auth: "agent" }),
    route("nobody", "GET", "/no-company", { auth: "board-or-agent" }),
    route("boom", "GET", "/boom", { companyResolution: { from: "query", key: "companyId" } }),
    route("empty", "GET", "/empty", { companyResolution: { from: "query", key: "companyId" } }),
    route("no-content", "GET", "/no-content", { companyResolution: { from: "query", key: "companyId" } }),
    route("db", "GET", "/db", { companyResolution: { from: "query", key: "companyId" } }),
  ];
  const withRoutes: PaperclipPluginManifestV1 = { ...defaultManifest, apiRoutes: ROUTES };

  function routedPlugin(calls: PluginApiRequestInput[] = []) {
    return definePlugin({
      async setup() {},
      async onApiRequest(input) {
        calls.push(input);
        switch (input.routeKey) {
          case "boom":
            throw new Error("handler exploded");
          case "empty":
            return undefined as never;
          case "no-content":
            return { status: 204, body: { ignored: true } };
          case "db":
            return { status: 200, body: await ctxRef().db.query("SELECT 1 AS one") };
          default:
            return {
              status: 200,
              headers: { "x-request-id": "r1", "set-cookie": "nope=1", "cache-control": "no-store" },
              body: { routeKey: input.routeKey, params: input.params, companyId: input.companyId },
            };
        }
      },
    });
  }
  let ctxRef: () => PluginContext;

  async function start(options: { manifest?: PaperclipPluginManifestV1; calls?: PluginApiRequestInput[] } = {}) {
    harness = await createBoardroomHarness({
      migrationsDir: FIXTURE_MIGRATIONS,
      manifest: options.manifest ?? withRoutes,
      plugin: routedPlugin(options.calls),
    });
    ctxRef = () => harness!.ctx;
    return harness;
  }

  it("answers 404 when the manifest declares no apiRoutes, without calling the worker", async () => {
    const calls: PluginApiRequestInput[] = [];
    harness = await createBoardroomHarness({
      migrationsDir: FIXTURE_MIGRATIONS,
      manifest: { ...defaultManifest, apiRoutes: undefined },
      plugin: routedPlugin(calls),
    });
    const company = await harness.seedCompany();
    const response = await harness.request("GET", "/rooms", { query: { companyId: company.id } });
    expect(response).toMatchObject({ status: 404, body: { error: "Plugin API route not found" } });
    expect(calls).toEqual([]);
  });

  it("answers 404 when the capability api.routes.register is not declared", async () => {
    const manifest = { ...withRoutes, capabilities: withRoutes.capabilities.filter((c) => c !== "api.routes.register") };
    const h = await start({ manifest });
    expect(await h.request("GET", "/rooms")).toMatchObject({ status: 404 });
  });

  it("answers 404 for an unknown path or a method the route does not accept", async () => {
    const calls: PluginApiRequestInput[] = [];
    const h = await start({ calls });
    const company = await h.seedCompany();
    const query = { companyId: company.id };
    expect((await h.request("GET", "/nothing", { query })).status).toBe(404);
    expect((await h.request("DELETE", "/rooms", { query })).status).toBe(404);
    expect((await h.request("GET", "/rooms/a/b", { query })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("matches the route and hands the worker the host's input shape", async () => {
    const calls: PluginApiRequestInput[] = [];
    const h = await start({ calls });
    const company = await h.seedCompany();
    const response = await h.request("GET", "/rooms/room%201/", {
      query: { companyId: company.id, tag: ["a", "b"] },
      headers: { Accept: "application/json", "X-Secret": "dropped" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ routeKey: "rooms.get", params: { roomId: "room 1" }, companyId: company.id });
    // Only allow-listed response headers come back.
    expect(response.headers).toEqual({ "x-request-id": "r1", "cache-control": "no-store" });
    expect(calls).toEqual([
      {
        routeKey: "rooms.get",
        method: "GET",
        path: "/rooms/room%201/",
        params: { roomId: "room 1" },
        query: { companyId: company.id, tag: ["a", "b"] },
        body: null,
        actor: BOARD_ACTOR,
        companyId: company.id,
        headers: { accept: "application/json" },
      },
    ]);
  });

  describe("route auth", () => {
    it("lets only a board user call a board route", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const query = { companyId: company.id };
      const agent = company.agents[0]!;
      expect(await h.request("GET", "/rooms", { query, actor: agent })).toMatchObject({
        status: 403,
        body: { error: "Board access required" },
      });
      expect((await h.request("GET", "/rooms", { query, actor: "anonymous" })).status).toBe(403);
      expect((await h.request("GET", "/rooms", { query, actor: company.members.viewer })).status).toBe(200);
    });

    it("lets only an agent call an agent route, and answers 401 with no actor", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const agent = company.agents[0]!;
      expect((await h.request("POST", "/ping", { actor: agent })).status).toBe(200);
      expect(await h.request("POST", "/ping", { actor: company.members.owner })).toMatchObject({
        status: 403,
        body: { error: "Agent access required" },
      });
      expect((await h.request("POST", "/ping", { actor: "anonymous" })).status).toBe(401);
    });

    it("answers 401 on a board-or-agent route with no actor", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const issue = await h.ctx.issues.create({ companyId: company.id, title: "x" });
      const response = await h.request("POST", `/issues/${issue.id}/touch`, { actor: "anonymous", body: {} });
      expect(response.status).toBe(401);
    });
  });

  describe("company resolution", () => {
    it("reads the company id from the body, the query or an issue param", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const issue = await h.ctx.issues.create({ companyId: company.id, title: "x" });
      expect((await h.request("POST", "/rooms", { body: { companyId: company.id } })).body).toMatchObject({
        companyId: company.id,
      });
      expect((await h.request("GET", "/rooms", { query: { companyId: company.id } })).body).toMatchObject({
        companyId: company.id,
      });
      expect((await h.request("POST", `/issues/${issue.id}/touch`, { body: {} })).body).toMatchObject({
        companyId: company.id,
      });
    });

    it("answers 400 when the company cannot be resolved", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const expected = { status: 400, body: { error: "Unable to resolve company for plugin API route" } };
      expect(await h.request("GET", "/rooms")).toMatchObject(expected);
      expect(await h.request("POST", "/rooms", { body: { companyId: 5 } })).toMatchObject(expected);
      expect(await h.request("GET", "/rooms", { query: { companyId: [company.id] } })).toMatchObject(expected);
      expect(await h.request("POST", "/issues/unknown/touch", { body: {} })).toMatchObject(expected);
      // A route with no companyResolution has a company only for an agent.
      expect(await h.request("GET", "/no-company")).toMatchObject(expected);
    });

    it("uses the agent's own company when the route declares no resolution", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const response = await h.request("GET", "/no-company", {
        actor: { id: company.agents[0]!.id, companyId: company.id },
      });
      expect(response.status).toBe(200);
    });
  });

  describe("company access", () => {
    it("gives the local board user every company (the default actor)", async () => {
      const h = await start();
      const a = await h.seedCompany();
      const b = await h.seedCompany();
      expect((await h.request("GET", "/rooms", { query: { companyId: a.id } })).status).toBe(200);
      expect((await h.request("POST", "/rooms", { body: { companyId: b.id } })).status).toBe(200);
    });

    it("refuses a signed-in user who is not a member of the company", async () => {
      const h = await start();
      const a = await h.seedCompany();
      const b = await h.seedCompany();
      const response = await h.request("GET", "/rooms", { query: { companyId: b.id }, actor: a.members.owner });
      expect(response).toMatchObject({ status: 403, body: { error: "User does not have access to this company" } });
    });

    it("lets a viewer read but not write", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const viewer = company.members.viewer;
      expect((await h.request("GET", "/rooms", { query: { companyId: company.id }, actor: viewer })).status).toBe(200);
      const write = await h.request("POST", "/rooms", { body: { companyId: company.id }, actor: viewer });
      expect(write).toMatchObject({ status: 403, body: { error: "Viewer access is read-only" } });
      for (const role of ["owner", "admin", "operator"] as const) {
        const ok = await h.request("POST", "/rooms", { body: { companyId: company.id }, actor: company.members[role] });
        expect(ok.status).toBe(200);
      }
    });

    it("refuses an agent of another company", async () => {
      const h = await start();
      const a = await h.seedCompany();
      const b = await h.seedCompany();
      const response = await h.request("POST", `/rooms`, { body: { companyId: b.id }, actor: a.agents[0]! });
      // The route is board-only, so the agent is stopped by route auth first.
      expect(response.status).toBe(403);
      const issue = await h.ctx.issues.create({ companyId: b.id, title: "other" });
      const touched = await h.request("POST", `/issues/${issue.id}/touch`, { body: {}, actor: a.agents[0]! });
      expect(touched).toMatchObject({ status: 403, body: { error: "Agent key cannot access another company" } });
      const own = await h.request("POST", `/issues/${issue.id}/touch`, { body: {}, actor: b.agents[0]! });
      expect(own.status).toBe(200);
    });
  });

  describe("request limits", () => {
    it("answers 415 for a non-JSON body and 413 for a body over 1 MB", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const text = await h.request("POST", "/rooms", {
        body: { companyId: company.id },
        headers: { "Content-Type": "text/plain" },
      });
      expect(text.status).toBe(415);
      const big = await h.request("POST", "/rooms", { body: { companyId: company.id, pad: "x".repeat(1_000_001) } });
      expect(big.status).toBe(413);
    });
  });

  describe("worker results and errors", () => {
    it("answers 502 when the handler throws: the status is lost across the RPC", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const response = await h.request("GET", "/boom", { query: { companyId: company.id } });
      expect(response).toMatchObject({ status: 502, body: { error: "handler exploded" } });
    });

    it("answers 500 when the handler returns nothing", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const response = await h.request("GET", "/empty", { query: { companyId: company.id } });
      expect(response.status).toBe(500);
    });

    it("drops the body of a 204", async () => {
      const h = await start();
      const company = await h.seedCompany();
      const response = await h.request("GET", "/no-content", { query: { companyId: company.id } });
      expect(response).toMatchObject({ status: 204, body: null });
    });

    it("answers 403 when the worker calls a host method the manifest has no capability for", async () => {
      const manifest = { ...withRoutes, capabilities: withRoutes.capabilities.filter((c) => c !== "database.namespace.read") };
      const h = await start({ manifest });
      const company = await h.seedCompany();
      const response = await h.request("GET", "/db", { query: { companyId: company.id } });
      expect(response.status).toBe(403);
      expect((response.body as { error: string }).error).toMatch(/missing required capability "database.namespace.read"/);
    });

    it("answers 501 when the plugin has no onApiRequest handler", async () => {
      harness = await createBoardroomHarness({
        migrationsDir: FIXTURE_MIGRATIONS,
        manifest: withRoutes,
        plugin: definePlugin({ async setup() {} }),
      });
      const company = await harness.seedCompany();
      expect((await harness.request("GET", "/rooms", { query: { companyId: company.id } })).status).toBe(501);
    });
  });
});

describe("parameter binding", () => {
  it("expands an array parameter into a parenthesised list, as drizzle 0.45 does", () => {
    expect(bindLikeHost("SELECT 1 WHERE id IN $1", [["a", "b"]])).toEqual({
      sql: "SELECT 1 WHERE id IN ($1, $2)",
      params: ["a", "b"],
    });
    expect(bindLikeHost("SELECT 1 WHERE a = $2 AND b IN $1 AND c = $2", [["x", "y"], "z"])).toEqual({
      sql: "SELECT 1 WHERE a = $1 AND b IN ($2, $3) AND c = $4",
      params: ["z", "x", "y", "z"],
    });
  });

  it("lets IN $1 with an array work and makes = ANY($1) with an array fail", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const company = await harness.seedCompany();
    for (const body of ["one", "two", "three"]) {
      await harness.ctx.db.execute(`INSERT INTO ${NOTES_TABLE} (company_id, body) VALUES ($1, $2)`, [company.id, body]);
    }
    const rows = await harness.ctx.db.query<{ body: string }>(
      `SELECT body FROM ${NOTES_TABLE} WHERE body IN $1 ORDER BY body`,
      [["one", "three"]],
    );
    expect(rows.map((r) => r.body)).toEqual(["one", "three"]);

    const failure = await harness.ctx.db
      .query(`SELECT body FROM ${NOTES_TABLE} WHERE body = ANY($1)`, [["one", "three"]])
      .catch((e: unknown) => e);
    expect((failure as Error).message).toMatch(/^Failed query: .*= ANY\(\(\$1, \$2\)\)\nparams: one,three$/s);
  });
});

describe("live-update spy", () => {
  it("records ctx.streams.emit calls with the channel's company", async () => {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("touch", async (params) => {
          ctx.streams.open("rooms", String(params.companyId));
          ctx.streams.emit("rooms", { type: "room.changed", roomId: "r1" });
          return null;
        });
      },
    });
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin });
    const company = await harness.seedCompany();
    await harness.sdk.getData("touch", { companyId: company.id });

    expect(harness.streamEvents).toEqual([
      { channel: "rooms", companyId: company.id, event: { type: "room.changed", roomId: "r1" } },
    ]);
  });
});

describe("agent sessions", () => {
  function sessionPlugin() {
    return definePlugin({
      async setup(ctx) {
        ctx.actions.register("ask", async (params) => {
          const companyId = String(params.companyId);
          const session = await ctx.agents.sessions.create(String(params.agentId), companyId);
          const replies: string[] = [];
          const sent = await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
            prompt: String(params.prompt),
            onEvent: (event) => {
              if (event.eventType === "done" && event.message) replies.push(event.message);
            },
          });
          ctx.data.register(`replies:${session.sessionId}`, async () => replies);
          return { sessionId: session.sessionId, runId: sent.runId };
        });
      },
    });
  }

  it("records sends, creates a queued run and delivers simulated events", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin: sessionPlugin() });
    const company = await harness.seedCompany({ agents: ["CEO"] });
    const agentId = company.agents[0]!.id;

    const { sessionId, runId } = await harness.sdk.performAction<{ sessionId: string; runId: string }>("ask", {
      companyId: company.id,
      agentId,
      prompt: "Should we raise prices?",
    });

    expect(harness.sessionSends).toEqual([
      expect.objectContaining({ sessionId, agentId, companyId: company.id, prompt: "Should we raise prices?", runId }),
    ]);
    // The host wakes the agent with an automation run.
    const runs = await harness.sql<{ status: string; agent_id: string; invocation_source: string }>(
      "SELECT status, agent_id, invocation_source FROM public.heartbeat_runs WHERE id = $1",
      [runId],
    );
    expect(runs).toEqual([{ status: "queued", agent_id: agentId, invocation_source: "automation" }]);

    harness.simulateSessionEvent(sessionId, {
      runId,
      seq: 1,
      eventType: "done",
      stream: "system",
      message: "Not yet.",
      payload: null,
    });
    await expect(harness.sdk.getData(`replies:${sessionId}`)).resolves.toEqual(["Not yet."]);
  });

  it("can make the next send fail, as the host does when a wake is refused", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin: sessionPlugin() });
    const company = await harness.seedCompany({ agents: ["CEO"] });

    harness.failNextSend(new Error("Agent is paused"));
    await expect(
      harness.sdk.performAction("ask", { companyId: company.id, agentId: company.agents[0]!.id, prompt: "hi" }),
    ).rejects.toThrow("Agent is paused");
    expect(harness.sessionSends).toEqual([expect.objectContaining({ prompt: "hi", error: "Agent is paused" })]);

    // Only the next send fails.
    await expect(
      harness.sdk.performAction("ask", { companyId: company.id, agentId: company.agents[0]!.id, prompt: "again" }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("can fail every send that matches a predicate", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin: sessionPlugin() });
    const company = await harness.seedCompany({ agents: ["CEO", "CTO"] });
    const [ceo, cto] = company.agents;
    harness.failSends((send) => send.agentId === cto!.id, () => new Error("Budget exceeded"));

    await expect(harness.sdk.performAction("ask", { companyId: company.id, agentId: cto!.id, prompt: "1" })).rejects.toThrow("Budget exceeded");
    await expect(harness.sdk.performAction("ask", { companyId: company.id, agentId: cto!.id, prompt: "2" })).rejects.toThrow("Budget exceeded");
    await expect(harness.sdk.performAction("ask", { companyId: company.id, agentId: ceo!.id, prompt: "3" })).resolves.toBeTruthy();
  });

  it("refuses a session for an agent of another company", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin: sessionPlugin() });
    const a = await harness.seedCompany({ agents: ["A1"] });
    const b = await harness.seedCompany({ agents: ["B1"] });
    await expect(
      harness.sdk.performAction("ask", { companyId: a.id, agentId: b.agents[0]!.id, prompt: "hi" }),
    ).rejects.toThrow(/Agent not found/);
  });
});

describe("restart()", () => {
  it("keeps database rows and drops harness memory", async () => {
    let setups = 0;
    const plugin = definePlugin({
      async setup(ctx) {
        setups += 1;
        let memory: string | null = null;
        ctx.actions.register("remember", async (params) => {
          memory = String(params.value);
          return null;
        });
        ctx.data.register("memory", async () => memory);
      },
    });
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin });
    const company = await harness.seedCompany({ agents: ["CEO"] });
    await harness.ctx.db.execute(`INSERT INTO ${NOTES_TABLE} (company_id, body) VALUES ($1, 'kept')`, [company.id]);
    await harness.sdk.performAction("remember", { value: "lost" });
    await expect(harness.sdk.getData("memory")).resolves.toBe("lost");
    const session = await harness.ctx.agents.sessions.create(company.agents[0]!.id, company.id);
    const { runId } = await harness.ctx.agents.sessions.sendMessage(session.sessionId, company.id, {
      prompt: "hi",
      onEvent: () => {},
    });
    const before = harness.ctx;

    await harness.restart();

    expect(setups).toBe(2);
    expect(harness.ctx).not.toBe(before);
    // Rows survive.
    const rows = await harness.ctx.db.query<{ body: string }>(`SELECT body FROM ${NOTES_TABLE} WHERE company_id = $1`, [company.id]);
    expect(rows.map((r) => r.body)).toEqual(["kept"]);
    // Harness memory does not.
    await expect(harness.sdk.getData("memory")).resolves.toBeNull();
    expect(() =>
      harness!.simulateSessionEvent(session.sessionId, { runId, seq: 1, eventType: "done", stream: null, message: "late", payload: null }),
    ).toThrow(/No active session event callback/);
    // Host-owned records survive a plugin restart: seeded entities and open sessions.
    expect((await harness.ctx.agents.list({ companyId: company.id })).map((a) => a.name)).toEqual(["CEO"]);
    await expect(
      harness.ctx.agents.sessions.sendMessage(session.sessionId, company.id, { prompt: "again" }),
    ).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("reloads the worker module so module-level memory is dropped too", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const before = harness.plugin;
    await harness.restart();
    expect(harness.plugin).not.toBe(before);
    expect(harness.logs.filter((l) => l.message === "Boardroom worker started")).toHaveLength(2);
  });

  it("keeps ctx.state, issue documents and issue comments, as the host stores them", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      ...defaultManifest,
      capabilities: [
        ...defaultManifest.capabilities,
        "plugin.state.read",
        "plugin.state.write",
        "issue.documents.read",
        "issue.comments.read",
        "issue.comments.create",
      ],
    };
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, manifest });
    const company = await harness.seedCompany({ agents: ["CEO"] });
    const scope = { scopeKind: "company", scopeId: company.id, stateKey: "last-room" } as const;
    const issue = await harness.ctx.issues.create({ companyId: company.id, title: "Decision" });
    await harness.ctx.state.set(scope, { roomId: "r1" });
    await harness.ctx.issues.documents.upsert({
      issueId: issue.id,
      companyId: company.id,
      key: "decision",
      title: "Decision",
      body: "# Decided",
    });
    await harness.ctx.issues.createComment(issue.id, "Room closed", company.id);

    await harness.restart();

    await expect(harness.ctx.state.get(scope)).resolves.toEqual({ roomId: "r1" });
    await expect(harness.ctx.issues.documents.get(issue.id, "decision", company.id)).resolves.toMatchObject({
      body: "# Decided",
      latestRevisionNumber: 1,
    });
    await expect(harness.ctx.issues.documents.list(issue.id, company.id)).resolves.toHaveLength(1);
    expect((await harness.ctx.issues.listComments(issue.id, company.id)).map((c) => c.body)).toEqual(["Room closed"]);
    expect((await harness.ctx.issues.get(issue.id, company.id))?.title).toBe("Decision");

    // The restarted context still writes to the same records, and a second restart keeps those too.
    await harness.ctx.issues.createComment(issue.id, "Follow-up", company.id);
    await harness.ctx.state.delete(scope);
    await harness.restart();
    expect((await harness.ctx.issues.listComments(issue.id, company.id)).map((c) => c.body)).toEqual([
      "Room closed",
      "Follow-up",
    ]);
    await expect(harness.ctx.state.get(scope)).resolves.toBeNull();
  });

  it("refuses state and documents without the capability, as the host does", async () => {
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS });
    const scope = { scopeKind: "instance", stateKey: "k" } as const;
    await expect(harness.ctx.state.get(scope)).rejects.toThrow(/missing required capability "plugin.state.read"/);
    await expect(harness.ctx.state.set(scope, 1)).rejects.toThrow(/missing required capability "plugin.state.write"/);
  });
});
