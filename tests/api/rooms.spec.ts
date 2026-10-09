/**
 * Rooms API (ticket 03): create, list and read Rooms through the plugin API route, with role
 * checks, company boundaries, activity entries, the live-update event and the 501 stubs.
 * Everything goes through `request()`, as the host would call the worker; the few checks of the
 * plugin's own role rules call the worker handler directly, because the host blocks those callers
 * first.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import defaultManifest from "../../src/manifest.js";
import { ROUTE_SPECS } from "../../src/api/route-table.js";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { RoomDetail, RoomListResponse } from "../../src/api/types.js";
import { insertMessage, removeParticipant } from "../../src/db/index.js";
import {
  createBoardroomHarness,
  type BoardroomHarness,
  type MemberRole,
  type SeededCompany,
} from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(): Promise<BoardroomHarness> {
  harness = await createBoardroomHarness();
  return harness;
}

/** A harness whose manifest also holds `access.members.write`, so a test can change roles. */
async function startWithMemberWrites(): Promise<BoardroomHarness> {
  harness = await createBoardroomHarness({
    manifest: { ...defaultManifest, capabilities: [...defaultManifest.capabilities, "access.members.write"] },
  });
  return harness;
}

const AGENTS_9 = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"];

function createBody(company: SeededCompany, extra: Record<string, unknown> = {}) {
  return {
    companyId: company.id,
    title: "Raise prices?",
    topic: "Should we raise prices by 10 percent next quarter?",
    agentIds: company.agents.map((a) => a.id),
    ...extra,
  };
}

async function createRoom(h: BoardroomHarness, company: SeededCompany, extra: Record<string, unknown> = {}, role: MemberRole = "operator") {
  return h.request<RoomDetail>("POST", "/rooms", { body: createBody(company, extra), actor: company.members[role] });
}

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = response.body as ApiErrorBody;
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe("string");
}

/** Call the worker as the host would after its own checks, to reach the plugin's own role rules. */
async function callWorker(
  h: BoardroomHarness,
  routeKey: string,
  input: { companyId: string; userId?: string; agentId?: string; params?: Record<string, string>; body?: unknown },
) {
  const spec = ROUTE_SPECS.find((s) => s.routeKey === routeKey);
  const actor = input.agentId
    ? { actorType: "agent" as const, actorId: input.agentId, agentId: input.agentId, userId: null, runId: null }
    : { actorType: "user" as const, actorId: input.userId!, userId: input.userId!, agentId: null, runId: null };
  const request: PluginApiRequestInput = {
    routeKey,
    method: spec?.method ?? "GET",
    path: spec?.path ?? "/",
    params: input.params ?? {},
    query: { companyId: input.companyId },
    body: input.body ?? null,
    actor,
    companyId: input.companyId,
    headers: {},
  };
  const response = await h.plugin.definition.onApiRequest!(JSON.parse(JSON.stringify(request)));
  return response as { status: number; body: unknown };
}

describe("manifest route table", () => {
  it("declares every route with board auth, the api.routes.register capability and company resolution", () => {
    const routes = defaultManifest.apiRoutes ?? [];
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "GET /rooms",
        "POST /rooms",
        "GET /rooms/:roomId",
        "PATCH /rooms/:roomId",
        "POST /rooms/:roomId/participants",
        "DELETE /rooms/:roomId/participants/:agentId",
        "GET /rooms/:roomId/messages",
        "POST /rooms/:roomId/messages",
        "GET /rooms/:roomId/rounds",
        "GET /rooms/:roomId/costs",
        "POST /rooms/:roomId/rounds/:roundId/pause",
        "POST /rooms/:roomId/rounds/:roundId/resume",
        "POST /rooms/:roomId/rounds/:roundId/stop",
        "POST /rooms/:roomId/close",
        "PATCH /rooms/:roomId/decision",
        "POST /rooms/:roomId/work",
        "POST /rooms/:roomId/work-links",
        "DELETE /rooms/:roomId/work-links/:issueId",
        "GET /issues/:issueId/rooms",
      ].sort(),
    );
    expect(new Set(routes.map((r) => r.routeKey)).size).toBe(routes.length);
    for (const route of routes) {
      expect(route.auth, route.routeKey).toBe("board");
      expect(route.capability, route.routeKey).toBe("api.routes.register");
      const expected =
        route.path.startsWith("/issues/")
          ? { from: "issue", param: "issueId" }
          : { from: ["GET", "DELETE"].includes(route.method) ? "query" : "body", key: "companyId" };
      expect(route.companyResolution, route.routeKey).toEqual(expected);
    }
  });
});

describe("POST /rooms", () => {
  it("lets an operator create a Room with three agents; the detail read returns the same", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const operator = company.members.operator;
    // Join order is the order given, not the agents' creation order.
    const [ceo, cto, cfo] = company.agents;
    const agentIds = [cfo!.id, ceo!.id, cto!.id];

    const created = await createRoom(h, company, { agentIds });
    expect(created.status).toBe(201);
    expect(created.body.room).toMatchObject({
      companyId: company.id,
      title: "Raise prices?",
      status: "open",
      ownerUserId: operator.userId,
      maxTotalTurns: 40,
      projectId: null,
    });
    expect(created.body.participants.map((p) => p.agentId)).toEqual(agentIds);
    expect(created.body.participants.map((p) => p.name)).toEqual(["CFO", "CEO", "CTO"]);
    expect(created.body.participants.every((p) => p.role === "general")).toBe(true);
    expect(created.body.activeRound).toBeNull();
    expect(created.body.workLinks).toEqual([]);

    const read = await h.request<RoomDetail>("GET", `/rooms/${created.body.room.id}`, {
      query: { companyId: company.id },
      actor: operator,
    });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
  });

  it("makes the local board user the Owner when it creates a Room", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const created = await h.request<RoomDetail>("POST", "/rooms", { body: createBody(company) });
    expect(created.status).toBe(201);
    expect(created.body.room.ownerUserId).toBe("local-board");
    expect(created.body.permissions).toEqual({ role: "owner", canPost: true, canControl: true });
  });

  it("refuses a viewer with 403 and still lets the viewer read", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const viewer = company.members.viewer;
    const refused = await h.request("POST", "/rooms", { body: createBody(company), actor: viewer });
    expect(refused.status).toBe(403);

    // The host stops a viewer first; the plugin enforces the same rule when called directly.
    const direct = await callWorker(h, "rooms.create", { companyId: company.id, userId: viewer.userId, body: createBody(company) });
    expectError(direct, 403, "role_cannot_post");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);

    const room = (await createRoom(h, company)).body.room;
    expect((await h.request("GET", "/rooms", { query: { companyId: company.id }, actor: viewer })).status).toBe(200);
    const detail = await h.request<RoomDetail>("GET", `/rooms/${room.id}`, { query: { companyId: company.id }, actor: viewer });
    expect(detail.status).toBe(200);
    expect(detail.body.permissions).toEqual({ role: "viewer", canPost: false, canControl: false });
  });

  it("refuses a caller with no active membership, even when the host lets the request through", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const stranger = await callWorker(h, "rooms.list", { companyId: company.id, userId: "someone-else" });
    expectError(stranger, 403, "not_a_company_member");
    const other = await h.seedCompany();
    const wrongCompany = await callWorker(h, "rooms.list", { companyId: other.id, userId: company.members.owner.userId });
    expectError(wrongCompany, 403, "not_a_company_member");
  });

  it("applies a role change at once (roles are looked up on every request)", async () => {
    harness = await createBoardroomHarness({
      manifest: { ...defaultManifest, capabilities: [...defaultManifest.capabilities, "access.members.write"] },
    });
    const h = harness;
    const company = await h.seedCompany();
    const operator = company.members.operator;
    const before = await callWorker(h, "rooms.create", { companyId: company.id, userId: operator.userId, body: createBody(company) });
    expect(before.status).toBe(201);
    await h.ctx.access.members.update(operator.memberId, { membershipRole: "viewer" } as never, company.id);
    const after = await callWorker(h, "rooms.create", { companyId: company.id, userId: operator.userId, body: createBody(company) });
    expectError(after, 403, "role_cannot_post");
  });

  it("refuses nine agents with 422 too_many_participants and accepts eight", async () => {
    const h = await start();
    const company = await h.seedCompany({ agents: AGENTS_9 });
    const ids = company.agents.map((a) => a.id);
    expectError(await createRoom(h, company, { agentIds: ids }), 422, "too_many_participants");
    const eight = await createRoom(h, company, { agentIds: ids.slice(0, 8) });
    expect(eight.status).toBe(201);
    expect(eight.body.participants).toHaveLength(8);
  });

  it("refuses an agent of another company with 422 agent_not_in_company, and creates nothing", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const response = await createRoom(h, a, { agentIds: [a.agents[0]!.id, b.agents[0]!.id] });
    expectError(response, 422, "agent_not_in_company");
    expect((response.body as unknown as ApiErrorBody).details).toEqual({ agentId: b.agents[0]!.id });
    expectError(await createRoom(h, a, { agentIds: ["not-a-uuid"] }), 422, "agent_not_in_company");
    expectError(await createRoom(h, a, { agentIds: [randomUUID()] }), 422, "agent_not_in_company");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
    expect(h.activity).toEqual([]);
    expect(h.streamEvents).toEqual([]);
  });

  it("refuses no agents and repeated agents with 422", async () => {
    const h = await start();
    const company = await h.seedCompany();
    expectError(await createRoom(h, company, { agentIds: [] }), 422, "participants_required");
    const id = company.agents[0]!.id;
    expectError(await createRoom(h, company, { agentIds: [id, id] }), 422, "duplicate_participant");
  });

  it.each([0, 201, -1, 5.5])("refuses a turn cap of %s with 422 turn_cap_out_of_range", async (cap) => {
    const h = await start();
    const company = await h.seedCompany();
    expectError(await createRoom(h, company, { maxTotalTurns: cap }), 422, "turn_cap_out_of_range");
  });

  it.each([1, 200])("accepts a turn cap of %s", async (cap) => {
    const h = await start();
    const company = await h.seedCompany();
    expect((await createRoom(h, company, { maxTotalTurns: cap })).body.room.maxTotalTurns).toBe(cap);
  });

  it("stores 40 when the cap is omitted or null", async () => {
    const h = await start();
    const company = await h.seedCompany();
    expect((await createRoom(h, company)).body.room.maxTotalTurns).toBe(40);
    expect((await createRoom(h, company, { maxTotalTurns: null })).body.room.maxTotalTurns).toBe(40);
  });

  it("answers 400 invalid_request for a malformed body", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const operator = company.members.operator;
    const post = (body: unknown) => h.request("POST", "/rooms", { body, actor: operator });
    expectError(await createRoom(h, company, { title: "   " }), 400, "invalid_request");
    expectError(await createRoom(h, company, { title: 5 }), 400, "invalid_request");
    expectError(await createRoom(h, company, { topic: "" }), 400, "invalid_request");
    expectError(await createRoom(h, company, { title: "x".repeat(201) }), 400, "invalid_request");
    expectError(await createRoom(h, company, { agentIds: "all" }), 400, "invalid_request");
    expectError(await createRoom(h, company, { agentIds: [1, 2] }), 400, "invalid_request");
    expectError(await createRoom(h, company, { maxTotalTurns: "40" }), 400, "invalid_request");
    expectError(await post({ companyId: company.id }), 400, "invalid_request");
  });

  it("links an existing issue as a `linked` work link and shows it in the detail", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Pricing review" });
    const created = await createRoom(h, company, { linkedIssueId: issue.id });
    expect(created.status).toBe(201);
    expect(created.body.workLinks).toHaveLength(1);
    expect(created.body.workLinks[0]).toMatchObject({
      issueId: issue.id,
      relation: "linked",
      roomId: created.body.room.id,
      byUserId: company.members.operator.userId,
    });
    const read = await h.request<RoomDetail>("GET", `/rooms/${created.body.room.id}`, {
      query: { companyId: company.id },
      actor: company.members.viewer,
    });
    expect(read.body.workLinks.map((l) => l.issueId)).toEqual([issue.id]);
  });

  it("refuses an issue of another company, or one that does not exist, with 422 issue_not_in_company", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const foreign = await h.ctx.issues.create({ companyId: b.id, title: "Theirs" });
    expectError(await createRoom(h, a, { linkedIssueId: foreign.id }), 422, "issue_not_in_company");
    expectError(await createRoom(h, a, { linkedIssueId: randomUUID() }), 422, "issue_not_in_company");
    expectError(await createRoom(h, a, { linkedIssueId: "nope" }), 422, "issue_not_in_company");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
  });

  it("stores a project of the company and refuses one of another company with 422", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const mine = randomUUID();
    const theirs = randomUUID();
    h.sdk.seed({
      projects: [
        { id: mine, companyId: a.id, name: "Mine" },
        { id: theirs, companyId: b.id, name: "Theirs" },
      ] as never,
    });
    expect((await createRoom(h, a, { projectId: mine })).body.room.projectId).toBe(mine);
    expectError(await createRoom(h, a, { projectId: theirs }), 422, "project_not_in_company");
    expectError(await createRoom(h, a, { projectId: randomUUID() }), 422, "project_not_in_company");
    expectError(await createRoom(h, a, { projectId: "nope" }), 422, "project_not_in_company");
  });

  it("writes Room created and one Participant added per agent, with the acting user and the Room", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const operator = company.members.operator;
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Pricing review" });
    const created = await createRoom(h, company, { linkedIssueId: issue.id });
    const roomId = created.body.room.id;

    expect(h.activity.map((e) => e.message)).toEqual([
      "Room created",
      "Participant added",
      "Participant added",
      "Participant added",
      "Work linked",
    ]);
    for (const entry of h.activity) {
      expect(entry.entityType).toBe("boardroom_room");
      expect(entry.entityId).toBe(roomId);
      expect(entry.metadata).toMatchObject({ actingUserId: operator.userId, roomId });
    }
    expect(h.activity[0]!.metadata).toMatchObject({ title: "Raise prices?", maxTotalTurns: 40, ownerUserId: operator.userId });
    expect(h.activity.slice(1, 4).map((e) => e.metadata?.agentId)).toEqual(company.agents.map((a) => a.id));
    expect(h.activity[4]!.metadata).toMatchObject({ issueId: issue.id, relation: "linked" });
  });

  it("emits room.changed once, on one channel, for the company of the Room", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const first = await createRoom(h, a);
    expect(h.streamEvents).toEqual([
      { channel: "boardroom", companyId: a.id, event: { type: "room.changed", roomId: first.body.room.id, companyId: a.id } },
    ]);
    // The channel is shared, so each emit must reach only its own company.
    const second = await createRoom(h, b);
    expect(h.streamEvents).toHaveLength(2);
    expect(h.streamEvents[1]).toEqual({
      channel: "boardroom",
      companyId: b.id,
      event: { type: "room.changed", roomId: second.body.room.id, companyId: b.id },
    });
    // Reads do not emit.
    await h.request("GET", "/rooms", { query: { companyId: a.id } });
    expect(h.streamEvents).toHaveLength(2);
  });

  it("leaves no half-built Room, activity entry or event when a write fails part way", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Pricing review" });
    const real = h.ctx.db;
    h.ctx.db = {
      namespace: real.namespace,
      query: real.query.bind(real),
      execute: async (sql, params) => {
        if (/INSERT INTO \S*work_links/.test(sql)) throw new Error("Failed query: boom");
        return real.execute(sql, params);
      },
    };
    const response = await createRoom(h, company, { linkedIssueId: issue.id });
    h.ctx.db = real;
    expectError(response, 500, "internal_error");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.room_participants")).toEqual([]);
    expect(h.activity).toEqual([]);
    expect(h.streamEvents).toEqual([]);
  });
});

/** Make the host database refuse the statements `fails` matches, and record every statement. */
function breakDb(h: BoardroomHarness, fails: (sql: string) => boolean) {
  const real = h.ctx.db;
  const executed: string[] = [];
  h.ctx.db = {
    namespace: real.namespace,
    query: real.query.bind(real),
    execute: async (sql, params) => {
      executed.push(sql);
      if (fails(sql)) throw new Error("Failed query: boom");
      return real.execute(sql, params);
    },
  };
  return { executed, restore: () => void (h.ctx.db = real) };
}

describe("POST /rooms failure windows", () => {
  it("writes every Participant with one statement", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const spy = breakDb(h, () => false);
    expect((await createRoom(h, company)).status).toBe(201);
    spy.restore();
    expect(spy.executed.filter((sql) => /INSERT INTO \S*room_participants/.test(sql))).toHaveLength(1);
  });

  it("rolls the Room back when the Participant insert fails, and reports 500", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const spy = breakDb(h, (sql) => /INSERT INTO \S*room_participants/.test(sql));
    const response = await createRoom(h, company);
    spy.restore();
    expectError(response, 500, "internal_error");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.room_participants")).toEqual([]);
    expect(spy.executed.some((sql) => /DELETE FROM \S*rooms/.test(sql))).toBe(true);
    expect(h.activity).toEqual([]);
    expect(h.streamEvents).toEqual([]);
    expect(h.logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
      "Boardroom could not finish creating a Room",
    ]);
  });

  it("logs a failed rollback loudly, still answers 500, and leaves the Room with no Participants", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const spy = breakDb(h, (sql) => /INSERT INTO \S*room_participants/.test(sql) || /DELETE FROM \S*rooms/.test(sql));
    const response = await createRoom(h, company);
    spy.restore();
    expectError(response, 500, "internal_error");
    const errors = h.logs.filter((l) => l.level === "error");
    expect(errors.map((l) => l.message)).toEqual([
      "Boardroom could not finish creating a Room",
      "Boardroom could not roll back a half-built Room; it is left without Participants",
    ]);
    const orphans = await h.sql<{ id: string }>("SELECT id FROM plugin_boardroom_79f8e138fc.rooms");
    expect(orphans).toHaveLength(1);
    expect(errors[1]!.meta).toMatchObject({ roomId: orphans[0]!.id, companyId: company.id });
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.room_participants")).toEqual([]);
    expect(h.activity).toEqual([]);
    expect(h.streamEvents).toEqual([]);
  });

  it("keeps the Room when only the audit write fails, and logs it", async () => {
    const h = await start();
    const company = await h.seedCompany();
    h.ctx.activity.log = async () => {
      throw new Error("activity store down");
    };
    const response = await createRoom(h, company);
    expect(response.status).toBe(201);
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toHaveLength(1);
    expect(h.streamEvents).toHaveLength(1);
    expect(h.logs.filter((l) => l.message === "Boardroom could not write an activity entry").length).toBeGreaterThan(0);
  });

  it("answers 201 with name null when an agent name lookup fails after the commit", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const realGet = h.ctx.agents.get.bind(h.ctx.agents);
    let calls = 0;
    h.ctx.agents.get = async (agentId, companyId) => {
      calls += 1;
      // The first three calls are the create's own checks; the detail lookups after the commit fail for one agent.
      if (calls > 3 && agentId === company.agents[1]!.id) throw new Error("agents service down");
      return realGet(agentId, companyId);
    };
    const created = await createRoom(h, company);
    expect(created.status).toBe(201);
    expect(created.body.participants.map((p) => p.name)).toEqual(["CEO", null, "CFO"]);
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toHaveLength(1);

    const read = await h.request<RoomDetail>("GET", `/rooms/${created.body.room.id}`, { query: { companyId: company.id } });
    expect(read.status).toBe(200);
    expect(read.body.participants.map((p) => p.name)).toEqual(["CEO", null, "CFO"]);
  });
});

describe("POST /rooms input handling", () => {
  it("stores quotes, unicode and SQL metacharacters in the title and topic unchanged", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const title = `O'Brien said "hi"; DROP TABLE rooms; -- \\ $1 %_ \u{1F680} caf\u00E9 \u4E2D\u6587`;
    const topic = `a'b"c;--/* x */ \n second line $$ \u{1F4A1}`;
    const created = await createRoom(h, company, { title, topic });
    expect(created.status).toBe(201);
    expect(created.body.room.title).toBe(title);
    expect(created.body.room.topic).toBe(topic);
    const read = await h.request<RoomDetail>("GET", `/rooms/${created.body.room.id}`, { query: { companyId: company.id } });
    expect(read.body.room).toMatchObject({ title, topic });
    const list = await h.request<RoomListResponse>("GET", "/rooms", { query: { companyId: company.id } });
    expect(list.body.rooms[0]!.title).toBe(title);
    expect(await h.sql<{ title: string }>("SELECT title FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([{ title }]);
  });

  it("treats an empty projectId or linkedIssueId as not given", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const created = await createRoom(h, company, { projectId: "", linkedIssueId: "" });
    expect(created.status).toBe(201);
    expect(created.body.room.projectId).toBeNull();
    expect(created.body.workLinks).toEqual([]);
    const blank = await createRoom(h, company, { projectId: "   ", linkedIssueId: " " });
    expect(blank.status).toBe(201);
    expect(blank.body.room.projectId).toBeNull();
  });

  it("lower-cases agent ids once: stored lower case, and a repeat in another case is a duplicate", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const [first, second] = company.agents;
    const created = await createRoom(h, company, { agentIds: [first!.id.toUpperCase(), second!.id] });
    expect(created.status).toBe(201);
    expect(created.body.participants.map((p) => p.agentId)).toEqual([first!.id, second!.id]);
    expect(await h.sql<{ agent_id: string }>("SELECT agent_id FROM plugin_boardroom_79f8e138fc.room_participants ORDER BY position")).toEqual([
      { agent_id: first!.id },
      { agent_id: second!.id },
    ]);
    expectError(
      await createRoom(h, company, { agentIds: [first!.id, first!.id.toUpperCase()] }),
      422,
      "duplicate_participant",
    );
  });

  it("answers 400 invalid_request when the company id is not a uuid, before any other check", async () => {
    const h = await start();
    const company = await h.seedCompany();
    for (const routeKey of ["rooms.list", "rooms.create", "rooms.get", "messages.send"]) {
      const response = await callWorker(h, routeKey, {
        companyId: "not-a-uuid",
        userId: company.members.owner.userId,
        params: { roomId: randomUUID() },
        body: {},
      });
      expectError(response, 400, "invalid_request");
    }
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
  });
});

describe("company roles", () => {
  it("treats a membership with no role as an operator: may post, controls only their own Rooms", async () => {
    const h = await startWithMemberWrites();
    const company = await h.seedCompany();
    const member = company.members.operator;
    await h.ctx.access.members.update(member.memberId, { membershipRole: null } as never, company.id);
    const stored = (await h.ctx.access.members.list({ companyId: company.id })).find((m) => m.principalId === member.userId)!;
    expect(stored.membershipRole).toBeNull();

    const created = await callWorker(h, "rooms.create", { companyId: company.id, userId: member.userId, body: createBody(company) });
    expect(created.status).toBe(201);
    const mine = created.body as RoomDetail;
    expect(mine.permissions).toEqual({ role: "operator", canPost: true, canControl: true });

    const owned = (await createRoom(h, company, {}, "admin")).body.room;
    const theirs = await callWorker(h, "rooms.get", { companyId: company.id, userId: member.userId, params: { roomId: owned.id } });
    expect((theirs.body as RoomDetail).permissions).toEqual({ role: "operator", canPost: true, canControl: false });
  });

  it("treats an unknown role string as a viewer", async () => {
    const h = await startWithMemberWrites();
    const company = await h.seedCompany();
    const member = company.members.operator;
    await h.ctx.access.members.update(member.memberId, { membershipRole: "superuser" } as never, company.id);
    const refused = await callWorker(h, "rooms.create", { companyId: company.id, userId: member.userId, body: createBody(company) });
    expectError(refused, 403, "role_cannot_post");
  });

  it("takes control away from a Room Owner who was downgraded to viewer", async () => {
    const h = await startWithMemberWrites();
    const company = await h.seedCompany();
    const operator = company.members.operator;
    const room = (await createRoom(h, company)).body.room; // owned by the operator
    const permissions = async () =>
      (await callWorker(h, "rooms.get", { companyId: company.id, userId: operator.userId, params: { roomId: room.id } })).body as RoomDetail;
    expect((await permissions()).permissions).toEqual({ role: "operator", canPost: true, canControl: true });
    await h.ctx.access.members.update(operator.memberId, { membershipRole: "viewer" } as never, company.id);
    const after = await permissions();
    expect(after.room.ownerUserId).toBe(operator.userId);
    expect(after.permissions).toEqual({ role: "viewer", canPost: false, canControl: false });
  });

  it("refuses the local board user with 403 when it has no active membership in the company", async () => {
    const h = await startWithMemberWrites();
    const company = await h.seedCompany();
    // The host seeds this membership at startup only; a company created another way has none.
    const board = (await h.ctx.access.members.list({ companyId: company.id })).find((m) => m.principalId === "local-board")!;
    await h.ctx.access.members.update(board.id, { status: "suspended" } as never, company.id);
    expectError(await h.request("GET", "/rooms", { query: { companyId: company.id } }), 403, "not_a_company_member");
    expectError(await h.request("POST", "/rooms", { body: createBody(company) }), 403, "not_a_company_member");
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.rooms")).toEqual([]);
  });
});

describe("GET /rooms", () => {
  it("lists the company's Rooms with Owner, Participant count and last activity, newest activity first", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const other = await h.seedCompany();
    const owner = company.members.owner;
    const older = (await createRoom(h, company, { title: "Older", agentIds: [company.agents[0]!.id] }, "owner")).body.room;
    const newer = (await createRoom(h, company, { title: "Newer" }, "operator")).body.room;
    await createRoom(h, other, { title: "Foreign" });

    const list = async (actor = owner) =>
      (await h.request<RoomListResponse>("GET", "/rooms", { query: { companyId: company.id }, actor })).body.rooms;

    let rooms = await list();
    expect(rooms.map((r) => r.title)).toEqual(["Newer", "Older"]);
    expect(rooms[0]).toMatchObject({ id: newer.id, status: "open", ownerUserId: company.members.operator.userId, participantCount: 3 });
    expect(rooms[1]).toMatchObject({ id: older.id, ownerUserId: owner.userId, participantCount: 1 });
    expect(typeof rooms[0]!.lastActivityAt).toBe("string");
    expect(rooms[0]!.lastActivityAt >= rooms[1]!.lastActivityAt).toBe(true);

    // A new Message in the older Room makes it the most recently active.
    const message = await insertMessage(h.ctx.db, company.id, {
      roomId: older.id,
      authorKind: "user",
      authorId: owner.userId,
      body: "ping",
    });
    rooms = await list();
    expect(rooms.map((r) => r.title)).toEqual(["Older", "Newer"]);
    expect(rooms[0]!.lastActivityAt).toBe(message!.createdAt);

    // Only active Participants count.
    await removeParticipant(h.ctx.db, company.id, newer.id, company.agents[1]!.id);
    expect((await list(company.members.viewer)).find((r) => r.id === newer.id)!.participantCount).toBe(2);
  });

  it("returns an empty list for a company with no Rooms", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const response = await h.request<RoomListResponse>("GET", "/rooms", { query: { companyId: company.id } });
    expect(response).toMatchObject({ status: 200, body: { rooms: [] } });
  });
});

describe("GET /rooms/:roomId", () => {
  it("answers 404 for a Room of another company, never 403", async () => {
    const h = await start();
    const a = await h.seedCompany();
    const b = await h.seedCompany();
    const room = (await createRoom(h, a)).body.room;
    const query = { companyId: b.id };
    for (const actor of [b.members.owner, b.members.viewer, undefined]) {
      const response = await h.request("GET", `/rooms/${room.id}`, { query, actor });
      expectError(response, 404, "room_not_found");
    }
    // Same answer as for a Room that does not exist, or an id that is not even a uuid.
    expectError(await h.request("GET", `/rooms/${randomUUID()}`, { query, actor: b.members.owner }), 404, "room_not_found");
    expectError(await h.request("GET", "/rooms/nope", { query, actor: b.members.owner }), 404, "room_not_found");
    // Company A's own member gets the Room with A's id, and the host refuses A's member under B's id.
    expect((await h.request("GET", `/rooms/${room.id}`, { query: { companyId: a.id }, actor: a.members.viewer })).status).toBe(200);
    expect((await h.request("GET", `/rooms/${room.id}`, { query, actor: a.members.owner })).status).toBe(403);
  });

  it("reports what the actor may do", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = (await createRoom(h, company)).body.room; // owned by the operator
    const permissions = async (role: MemberRole) =>
      (await h.request<RoomDetail>("GET", `/rooms/${room.id}`, { query: { companyId: company.id }, actor: company.members[role] })).body
        .permissions;
    expect(await permissions("operator")).toEqual({ role: "operator", canPost: true, canControl: true });
    expect(await permissions("owner")).toEqual({ role: "owner", canPost: true, canControl: true });
    expect(await permissions("admin")).toEqual({ role: "admin", canPost: true, canControl: true });
    expect(await permissions("viewer")).toEqual({ role: "viewer", canPost: false, canControl: false });

    // Another operator posts but does not control a Room they do not own.
    const second = await h.seedCompany();
    const mine = (await createRoom(h, second, {}, "admin")).body.room;
    const peer = await h.request<RoomDetail>("GET", `/rooms/${mine.id}`, {
      query: { companyId: second.id },
      actor: second.members.operator,
    });
    expect(peer.body.permissions).toEqual({ role: "operator", canPost: true, canControl: false });
  });
});

describe("agent actors and not-yet-built routes", () => {
  type Spec = (typeof ROUTE_SPECS)[number];
  const BUILT = new Set(["rooms.list", "rooms.create", "rooms.get", "work.create", "work-links.add", "work-links.remove"]);

  async function requestFor(h: BoardroomHarness, spec: Spec, company: SeededCompany, issueId: string, actor?: Parameters<BoardroomHarness["request"]>[2] extends infer O ? (O extends { actor?: infer A } ? A : never) : never) {
    const path = spec.path
      .replace(":roomId", randomUUID())
      .replace(":agentId", company.agents[0]!.id)
      .replace(":roundId", randomUUID())
      .replace(":issueId", issueId);
    const isQuery = spec.company === "query";
    return h.request(spec.method, path, {
      ...(isQuery ? { query: { companyId: company.id } } : { body: spec.company === "body" ? { companyId: company.id } : {} }),
      actor,
    });
  }

  it("answers an agent actor with 403 on every route", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Work" });
    for (const spec of ROUTE_SPECS) {
      const response = await requestFor(h, spec, company, issue.id, company.agents[0]!);
      expect(response.status, spec.routeKey).toBe(403);
    }
    expect(h.activity).toEqual([]);
    expect(h.streamEvents).toEqual([]);
  });

  it("refuses an agent in the plugin itself too (defence in depth)", async () => {
    const h = await start();
    const company = await h.seedCompany();
    for (const spec of ROUTE_SPECS) {
      const response = await callWorker(h, spec.routeKey, { companyId: company.id, agentId: company.agents[0]!.id });
      expectError(response, 403, "agent_not_allowed");
    }
  });

  it("answers 501 not_implemented on every route that is not built yet", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Work" });
    for (const spec of ROUTE_SPECS) {
      if (BUILT.has(spec.routeKey)) continue;
      const response = await requestFor(h, spec, company, issue.id, company.members.owner);
      expectError(response, 501, "not_implemented");
    }
  });

  it("refuses a non-member before answering 501", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const response = await callWorker(h, "messages.send", { companyId: company.id, userId: "nobody", params: { roomId: randomUUID() } });
    expectError(response, 403, "not_a_company_member");
  });

  it("answers 404 for a route key it does not know", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const response = await callWorker(h, "nothing.here", { companyId: company.id, userId: company.members.owner.userId });
    expectError(response, 404, "route_not_found");
  });
});
