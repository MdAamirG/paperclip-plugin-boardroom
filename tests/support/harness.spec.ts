import { definePlugin } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARDROOM_NAMESPACE,
  BOARD_ACTOR,
  createBoardroomHarness,
  type BoardroomHarness,
} from "./harness.js";

const FIXTURE_MIGRATIONS = new URL("../fixtures/migrations/", import.meta.url);
const T = `${BOARDROOM_NAMESPACE}.fixture_notes`;

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
      `INSERT INTO ${T} (company_id, body, pinned) VALUES ($1, $2, $3)`,
      [company.id, "hello", true],
    );
    expect(rowCount).toBe(1);

    const rows = await harness.ctx.db.query<{ body: string; pinned: boolean; created_at: string }>(
      `SELECT body, pinned, created_at FROM ${T} WHERE company_id = $1`,
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
      harness.ctx.db.query(`DELETE FROM ${T} WHERE company_id = $1`, [company.id]),
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
    expect(members.map((m) => m.membershipRole).sort()).toEqual(["admin", "operator", "owner", "viewer"]);
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

describe("request(...)", () => {
  it("calls onApiRequest as the host would, with a board actor by default", async () => {
    const seen: unknown[] = [];
    const plugin = definePlugin({
      async setup() {},
      async onApiRequest(input) {
        seen.push(input);
        return { status: 201, body: { ok: true, at: new Date(0) } };
      },
    });
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin });
    const company = await harness.seedCompany();

    const response = await harness.request("rooms.create", {
      method: "POST",
      path: "/rooms",
      body: { title: "Pricing" },
      companyId: company.id,
    });

    expect(response).toEqual({ status: 201, headers: {}, body: { ok: true, at: "1970-01-01T00:00:00.000Z" } });
    expect(seen[0]).toEqual({
      routeKey: "rooms.create",
      method: "POST",
      path: "/rooms",
      params: {},
      query: {},
      body: { title: "Pricing" },
      actor: BOARD_ACTOR,
      companyId: company.id,
      headers: { "content-type": "application/json" },
    });
  });

  it("maps a seeded member or agent to the host's actor shape", async () => {
    const actors: unknown[] = [];
    const plugin = definePlugin({
      async setup() {},
      async onApiRequest(input) {
        actors.push(input.actor);
        return { status: 204 };
      },
    });
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin });
    const company = await harness.seedCompany({ agents: ["CEO"] });

    await harness.request("x", { companyId: company.id, actor: company.members.operator });
    await harness.request("x", { companyId: company.id, actor: company.agents[0]! });

    expect(actors).toEqual([
      { actorType: "user", actorId: company.members.operator.userId, userId: company.members.operator.userId, agentId: null, runId: null },
      { actorType: "agent", actorId: company.agents[0]!.id, userId: null, agentId: company.agents[0]!.id, runId: null },
    ]);
  });

  it("turns a thrown error into the host's 502, because a status on an error does not cross the worker RPC", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onApiRequest() {
        throw Object.assign(new Error("Room is closed"), { status: 409 });
      },
    });
    harness = await createBoardroomHarness({ migrationsDir: FIXTURE_MIGRATIONS, plugin });
    const company = await harness.seedCompany();
    await expect(harness.request("x", { companyId: company.id })).resolves.toEqual({
      status: 502,
      headers: {},
      body: { error: "Room is closed" },
    });
  });

  it("answers 501 when the plugin has no onApiRequest", async () => {
    harness = await createBoardroomHarness({
      migrationsDir: FIXTURE_MIGRATIONS,
      plugin: definePlugin({ async setup() {} }),
    });
    const company = await harness.seedCompany();
    await expect(harness.request("x", { companyId: company.id })).resolves.toMatchObject({ status: 501 });
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
    const runs = await harness.sql<{ status: string; agent_id: string }>(
      "SELECT status, agent_id FROM public.heartbeat_runs WHERE id = $1",
      [runId],
    );
    expect(runs).toEqual([{ status: "queued", agent_id: agentId }]);

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
    await harness.ctx.db.execute(`INSERT INTO ${T} (company_id, body) VALUES ($1, 'kept')`, [company.id]);
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
    const rows = await harness.ctx.db.query<{ body: string }>(`SELECT body FROM ${T} WHERE company_id = $1`, [company.id]);
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
});
