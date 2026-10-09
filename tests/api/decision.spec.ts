/**
 * Decision record (ticket 11): PATCH /rooms/:roomId/decision through the plugin API route, as the
 * host would call it. The few checks of the plugin's own role rules call the worker directly,
 * because the host blocks viewers and agents first.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { DECISION_MAX, EXCERPT_MAX } from "../../src/api/decision.js";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { RoomDetail } from "../../src/api/types.js";
import { insertMessage, insertRound } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness, type MemberRole, type SeededCompany } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start() {
  harness = await createBoardroomHarness();
  const company = await harness.seedCompany();
  return { h: harness, company };
}

/** A Room created by `creator` (its Owner). */
async function createRoom(h: BoardroomHarness, company: SeededCompany, creator: MemberRole = "operator") {
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title: "Raise prices?", topic: "Should we?", agentIds: company.agents.map((a) => a.id) },
    actor: company.members[creator],
  });
  expect(created.status).toBe(201);
  return created.body.room;
}

function save(h: BoardroomHarness, company: SeededCompany, roomId: string, decisionMd: unknown, role?: MemberRole) {
  return h.request<RoomDetail>("PATCH", `/rooms/${roomId}/decision`, {
    body: { companyId: company.id, decisionMd },
    ...(role ? { actor: company.members[role] } : {}),
  });
}

function get(h: BoardroomHarness, company: SeededCompany, roomId: string, role: MemberRole = "viewer") {
  return h.request<RoomDetail>("GET", `/rooms/${roomId}`, { query: { companyId: company.id }, actor: company.members[role] });
}

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((response.body as ApiErrorBody).error).toBe(code);
}

async function callWorker(h: BoardroomHarness, companyId: string, userId: string, roomId: string, body: unknown) {
  const request: PluginApiRequestInput = {
    routeKey: "decision.update",
    method: "PATCH",
    path: "/rooms/:roomId/decision",
    params: { roomId },
    query: {},
    body,
    actor: { actorType: "user", actorId: userId, userId, agentId: null, runId: null },
    companyId,
    headers: {},
  };
  return (await h.plugin.definition.onApiRequest!(JSON.parse(JSON.stringify(request)))) as { status: number; body: unknown };
}

/** `h.activity` is a copy, so "forget what happened so far" is a mark to slice from. */
const marks = new WeakMap<BoardroomHarness, number>();
const mark = (h: BoardroomHarness) => marks.set(h, h.activity.length);
const activitySince = (h: BoardroomHarness) => h.activity.slice(marks.get(h) ?? 0);

const ROOMS = "plugin_boardroom_79f8e138fc.rooms";

describe("PATCH /rooms/:roomId/decision", () => {
  it("lets the Owner save a record; the detail returns the body, the Owner as writer and a time", async () => {
    const { h, company } = await start();
    const operator = company.members.operator;
    const room = await createRoom(h, company, "operator");
    expect(room.decisionMd).toBeNull();
    expect((await get(h, company, room.id)).body.decision).toBeNull();

    const before = Date.now();
    const saved = await save(h, company, room.id, "# Raise prices\n\nWe raise by **10 percent** because of costs.", "operator");
    expect(saved.status).toBe(200);
    expect(saved.body.decision).toMatchObject({
      markdown: "# Raise prices\n\nWe raise by **10 percent** because of costs.",
      writer: { userId: operator.userId, name: null },
    });
    const at = Date.parse(saved.body.decision!.at);
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(saved.body.room).toMatchObject({ decisionMd: saved.body.decision!.markdown, decisionByUserId: operator.userId, decisionAt: saved.body.decision!.at });
    expect(saved.body.permissions.canControl).toBe(true);

    // Every member reads the same record, a viewer included.
    for (const role of ["viewer", "operator", "admin", "owner"] as const) {
      const read = await get(h, company, room.id, role);
      expect(read.status).toBe(200);
      expect(read.body.decision).toEqual(saved.body.decision);
    }
  });

  it("lets an admin who is not the Owner and a company owner save and replace the record", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    const byAdmin = await save(h, company, room.id, "First", "admin");
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.decision?.writer.userId).toBe(company.members.admin.userId);
    const byOwner = await save(h, company, room.id, "Second", "owner");
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.decision).toMatchObject({ markdown: "Second", writer: { userId: company.members.owner.userId } });
    expect(Date.parse(byOwner.body.decision!.at)).toBeGreaterThanOrEqual(Date.parse(byAdmin.body.decision!.at));
  });

  it("works for the local board user", async () => {
    const { h, company } = await start();
    const created = await h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: company.id, title: "T", topic: "X", agentIds: [company.agents[0]!.id] },
    });
    const saved = await save(h, company, created.body.room.id, "Decided");
    expect(saved.status).toBe(200);
    expect(saved.body.decision?.writer.userId).toBe("local-board");
  });

  it("refuses an operator who is not the Owner and a viewer with 403, who can still read the record", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "owner");
    await save(h, company, room.id, "Kept", "owner");
    mark(h);
    h.streamEvents.length = 0;

    // The host stops a viewer first.
    expect((await save(h, company, room.id, "Changed", "viewer")).status).toBe(403);
    // The operator reaches the plugin and is refused by its own rule.
    expectError(await save(h, company, room.id, "Changed", "operator"), 403, "control_requires_owner_or_admin");
    // The plugin refuses a viewer by itself when called directly.
    expectError(
      await callWorker(h, company.id, company.members.viewer.userId, room.id, { companyId: company.id, decisionMd: "Changed" }),
      403,
      "control_requires_owner_or_admin",
    );

    const read = await get(h, company, room.id, "viewer");
    expect(read.body.decision?.markdown).toBe("Kept");
    expect(read.body.permissions).toEqual({ role: "viewer", canPost: false, canControl: false });
    expect(activitySince(h)).toEqual([]);
    expect(h.streamEvents).toEqual([]);
  });

  it("refuses a viewer and an agent", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    expect((await save(h, company, room.id, "x", "viewer")).status).toBe(403);
    const agent = await h.request("PATCH", `/rooms/${room.id}/decision`, {
      body: { companyId: company.id, decisionMd: "x" },
      actor: company.agents[0]!,
    });
    expect(agent.status).toBe(403);
  });

  it("saves in a closed Room", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await h.sql(`UPDATE ${ROOMS} SET status = 'closed', closed_at = now() WHERE id = $1`, [room.id]);
    const saved = await save(h, company, room.id, "Late outcome", "operator");
    expect(saved.status).toBe(200);
    expect(saved.body.room.status).toBe("closed");
    expect(saved.body.decision?.markdown).toBe("Late outcome");
    expect(saved.body.permissions).toMatchObject({ canPost: false, canControl: true });
  });

  it("saves during a running Round and does not touch it", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    const message = await insertMessage(h.ctx.db, company.id, {
      roomId: room.id,
      authorKind: "user",
      authorId: company.members.operator.userId,
      body: "Go",
    });
    const round = await insertRound(h.ctx.db, company.id, {
      roomId: room.id,
      seq: 1,
      startedByUserId: company.members.operator.userId,
      triggerMessageId: message!.id,
      askAll: false,
      addressedAgentIds: [],
    });
    const saved = await save(h, company, room.id, "Interim", "operator");
    expect(saved.status).toBe(200);
    expect(saved.body.activeRound).toMatchObject({ id: round!.id, status: "running" });
    expect(saved.body.decision?.markdown).toBe("Interim");
  });

  it("returns 404 for a Room of another company or a malformed or unknown id", async () => {
    const { h, company } = await start();
    const other = await h.seedCompany();
    const theirs = await createRoom(h, other, "operator");
    expectError(await save(h, company, theirs.id, "Mine now", "operator"), 404, "room_not_found");
    expectError(await save(h, company, randomUUID(), "x", "operator"), 404, "room_not_found");
    const malformed = await h.request("PATCH", "/rooms/not-an-id/decision", {
      body: { companyId: company.id, decisionMd: "x" },
      actor: company.members.operator,
    });
    expectError(malformed, 404, "room_not_found");
    const read = await get(h, other, theirs.id, "owner");
    expect(read.body.decision).toBeNull();
  });

  it("clears the record with an empty or blank string", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await save(h, company, room.id, "Something", "operator");
    for (const blank of ["", "  \n\t "]) {
      await save(h, company, room.id, "Something", "operator");
      const cleared = await save(h, company, room.id, blank, "operator");
      expect(cleared.status).toBe(200);
      expect(cleared.body.decision).toBeNull();
      expect(cleared.body.room).toMatchObject({ decisionMd: null, decisionByUserId: null, decisionAt: null });
    }
    expect((await get(h, company, room.id)).body.decision).toBeNull();
  });

  it("keeps the markdown exactly as written (unicode, quotes, SQL characters)", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    const text = "Plan: it's \"fine\"; DROP TABLE rooms; -- $1 ' \\ \n- café ✓ 日本語\n\n```ts\nconst x = 1;\n```\n";
    const saved = await save(h, company, room.id, text, "operator");
    expect(saved.body.decision?.markdown).toBe(text);
    expect((await get(h, company, room.id)).body.decision?.markdown).toBe(text);
  });

  it("answers 400 for a missing, non-string or too long body and changes nothing", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await save(h, company, room.id, "Kept", "operator");
    mark(h);
    h.streamEvents.length = 0;
    for (const bad of [undefined, null, 5, ["a"], { a: 1 }]) {
      expectError(await save(h, company, room.id, bad, "operator"), 400, "invalid_request");
    }
    expectError(await save(h, company, room.id, "x".repeat(DECISION_MAX + 1), "operator"), 400, "invalid_request");
    expect((await save(h, company, room.id, "x".repeat(DECISION_MAX), "operator")).status).toBe(200);
    expect((await get(h, company, room.id)).body.decision?.markdown).toHaveLength(DECISION_MAX);
  });

  it("writes one Decision recorded entry with a short excerpt, and emits room.changed once", async () => {
    const { h, company } = await start();
    const operator = company.members.operator;
    const room = await createRoom(h, company, "operator");
    mark(h);
    h.streamEvents.length = 0;

    const long = `# Decision\n\n${"We agreed to raise prices after reviewing costs. ".repeat(20)}SECRET-TAIL`;
    expect((await save(h, company, room.id, long, "operator")).status).toBe(200);

    expect(activitySince(h)).toHaveLength(1);
    const entry = activitySince(h)[0]!;
    expect(entry).toMatchObject({ message: "Decision recorded", entityType: "boardroom_room", entityId: room.id });
    expect(entry.metadata).toMatchObject({ actingUserId: operator.userId, roomId: room.id, length: long.length, replaced: false });
    const excerpt = String(entry.metadata?.excerpt);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(excerpt.startsWith("# Decision We agreed to raise prices")).toBe(true);
    expect(excerpt).not.toContain("SECRET-TAIL");
    expect(excerpt).not.toContain("\n");
    expect(JSON.stringify(entry.metadata)).not.toContain("SECRET-TAIL");

    expect(h.streamEvents).toEqual([
      { channel: "boardroom", companyId: company.id, event: { type: "room.changed", roomId: room.id, companyId: company.id } },
    ]);

    await save(h, company, room.id, "Short", "operator");
    expect(activitySince(h)).toHaveLength(2);
    expect(activitySince(h)[1]!.metadata).toMatchObject({ excerpt: "Short", replaced: true });
    expect(h.streamEvents).toHaveLength(2);
  });

  it("writes Decision cleared (not recorded) when the record is emptied", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await save(h, company, room.id, "Something", "operator");
    mark(h);
    await save(h, company, room.id, "", "operator");
    expect(activitySince(h).map((e) => e.message)).toEqual(["Decision cleared"]);
    expect(activitySince(h)[0]!.metadata).toMatchObject({ hadDecision: true });
  });

  it("bumps the Room's updated_at so the list order follows it", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await h.sql(`UPDATE ${ROOMS} SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [room.id]);
    const saved = await save(h, company, room.id, "x", "operator");
    expect(Date.parse(saved.body.room.updatedAt)).toBeGreaterThan(Date.parse("2021-01-01T00:00:00Z"));
  });

  it("still saves when the activity write or the member lookup fails", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    h.ctx.activity.log = async () => {
      throw new Error("activity down");
    };
    expect((await save(h, company, room.id, "Saved anyway", "operator")).status).toBe(200);
    const members = h.ctx.access.members.list.bind(h.ctx.access.members);
    let calls = 0;
    h.ctx.access.members.list = async (input) => {
      calls += 1;
      // The first call is the actor lookup of the request; the writer lookup is the second.
      if (calls === 2) throw new Error("lookup down");
      return members(input);
    };
    const read = await get(h, company, room.id, "viewer");
    expect(read.status).toBe(200);
    expect(read.body.decision).toMatchObject({ markdown: "Saved anyway", writer: { userId: company.members.operator.userId, name: null } });
  });

  it("shows a member name from the member lookup when the host provides one", async () => {
    const { h, company } = await start();
    const room = await createRoom(h, company, "operator");
    await save(h, company, room.id, "x", "operator");
    const members = h.ctx.access.members.list.bind(h.ctx.access.members);
    h.ctx.access.members.list = async (input) =>
      (await members(input)).map((m) => (m.principalId === company.members.operator.userId ? ({ ...m, displayName: "Olive Operator" } as typeof m) : m));
    expect((await get(h, company, room.id, "viewer")).body.decision?.writer).toEqual({
      userId: company.members.operator.userId,
      name: "Olive Operator",
    });
  });
});
