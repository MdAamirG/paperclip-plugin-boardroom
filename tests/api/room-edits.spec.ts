/**
 * Participant edits, Room settings and closing a Room (ticket 10), through the plugin API handler.
 * A Round is "active" here the way ticket 06 makes one: the Owner mentions an agent and the Turn
 * waits for a session event.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { MessageListResponse, RoomDetail, SendMessageResponse } from "../../src/api/types.js";
import { getActiveRound, setRoundStatus } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const NAMES = ["CEO", "CTO", "CFO", "COO", "CMO", "CIO", "CPO", "CSO", "CLO", "CRO"];

async function setup(options: { initial?: number; maxTotalTurns?: number } = {}) {
  harness = await createBoardroomHarness({ everyCompanyConfigured: true });
  const h = harness;
  const company = await h.seedCompany({ agents: NAMES });
  const initial = company.agents.slice(0, options.initial ?? 3);
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: {
      companyId: company.id,
      title: "Raise prices?",
      topic: "Should we raise prices?",
      agentIds: initial.map((a) => a.id),
      ...(options.maxTotalTurns ? { maxTotalTurns: options.maxTotalTurns } : {}),
    },
    actor: owner,
  });
  expect(created.status).toBe(201);
  return { h, company, room: created.body.room, owner, admin: company.members.admin, operator: company.members.operator, viewer: company.members.viewer, initial };
}
type Setup = Awaited<ReturnType<typeof setup>>;
type Actor = Setup["owner"];

const add = (s: Setup, agentId: string, actor: Actor = s.owner, companyId = s.company.id) =>
  s.h.request<RoomDetail>("POST", `/rooms/${s.room.id}/participants`, { body: { companyId, agentId }, actor });
const remove = (s: Setup, agentId: string, actor: Actor = s.owner) =>
  s.h.request<RoomDetail>("DELETE", `/rooms/${s.room.id}/participants/${agentId}`, { query: { companyId: s.company.id }, actor });
const patch = (s: Setup, body: Record<string, unknown>, actor: Actor = s.owner) =>
  s.h.request<RoomDetail>("PATCH", `/rooms/${s.room.id}`, { body: { companyId: s.company.id, ...body }, actor });
const close = (s: Setup, actor: Actor = s.owner) =>
  s.h.request<RoomDetail>("POST", `/rooms/${s.room.id}/close`, { body: { companyId: s.company.id }, actor });
const note = (s: Setup, body: Record<string, unknown> = {}, actor: Actor = s.owner) =>
  s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "A note", ...body },
    actor,
  });
const read = (s: Setup, actor: Actor = s.viewer) =>
  s.h.request<RoomDetail>("GET", `/rooms/${s.room.id}`, { query: { companyId: s.company.id }, actor });

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((response.body as ApiErrorBody).error).toBe(code);
}

/** Start a Round (it stays running: no session event arrives). */
async function startRound(s: Setup, agentIds = [s.initial[0]!.id]) {
  const response = await note(s, { mentions: agentIds });
  expect(response.status).toBe(201);
  return response.body.round!;
}

describe("add Participant", () => {
  it("adds a fourth agent between Rounds, last in join order, with activity and a live event", async () => {
    const s = await setup();
    const fourth = s.company.agents[3]!;
    s.h.streamEvents.length = 0;
    const before = s.h.activity.length;
    const response = await add(s, fourth.id);
    expect(response.status).toBe(201);
    expect(response.body.participants.map((p) => p.agentId)).toEqual([...s.initial.map((a) => a.id), fourth.id]);
    expect(response.body.participants.at(-1)).toMatchObject({ name: "COO", addedByUserId: s.owner.userId });
    expect((await read(s)).body.participants.at(-1)!.agentId).toBe(fourth.id);
    const entries = s.h.activity.slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: "Participant added", entityId: s.room.id });
    expect(entries[0]!.metadata).toMatchObject({ agentId: fourth.id, actingUserId: s.owner.userId });
    expect(s.h.streamEvents.length).toBeGreaterThan(0);
  });

  it("refuses a duplicate, a foreign agent and a malformed body", async () => {
    const s = await setup();
    expectError(await add(s, s.initial[0]!.id), 409, "already_participant");
    const other = await s.h.seedCompany({ agents: ["Stranger"] });
    expectError(await add(s, other.agents[0]!.id), 422, "agent_not_in_company");
    expectError(await add(s, randomUUID()), 422, "agent_not_in_company");
    expectError(await add(s, "not-an-id"), 422, "agent_not_in_company");
    const bad = await s.h.request("POST", `/rooms/${s.room.id}/participants`, { body: { companyId: s.company.id }, actor: s.owner });
    expectError(bad, 400, "invalid_request");
  });

  it("refuses a ninth active Participant, then accepts one after a removal", async () => {
    const s = await setup({ initial: 8 });
    const ninth = s.company.agents[8]!;
    const refused = await add(s, ninth.id);
    expectError(refused, 422, "too_many_participants");
    expect((refused.body as unknown as ApiErrorBody).details).toMatchObject({ limit: 8, active: 8 });
    expect((await remove(s, s.initial[7]!.id)).status).toBe(200);
    expect((await add(s, ninth.id)).status).toBe(201);
  });

  it("re-adding a removed agent creates a new active row at the end of the join order", async () => {
    const s = await setup();
    const first = s.initial[0]!;
    await remove(s, first.id);
    const response = await add(s, first.id);
    expect(response.status).toBe(201);
    expect(response.body.participants.map((p) => p.agentId)).toEqual([s.initial[1]!.id, s.initial[2]!.id, first.id]);
    const rows = await s.h.sql<{ removed_at: string | null }>(
      `SELECT removed_at FROM plugin_boardroom_79f8e138fc.room_participants WHERE agent_id = '${first.id}' ORDER BY position`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.removed_at).not.toBeNull();
    expect(rows[1]!.removed_at).toBeNull();
  });
});

describe("remove Participant", () => {
  it("soft-removes, keeps earlier Messages attributed to the agent and ignores a later mention with a notice", async () => {
    const s = await setup();
    const [ceo, cto] = s.initial;
    const round = await startRound(s, [ceo!.id]);
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message: "My answer", payload: null });
    await vi.waitFor(async () => expect(await getActiveRound(s.h.ctx.db, s.company.id, s.room.id)).toBeNull());
    expect(round.id).toBeTruthy();

    s.h.streamEvents.length = 0;
    const before = s.h.activity.length;
    const response = await remove(s, ceo!.id);
    expect(response.status).toBe(200);
    expect(response.body.participants.map((p) => p.agentId)).toEqual([cto!.id, s.initial[2]!.id]);
    expect(s.h.activity.slice(before).map((e) => e.message)).toEqual(["Participant removed"]);
    expect(s.h.activity.slice(before)[0]!.metadata).toMatchObject({ agentId: ceo!.id });
    expect(s.h.streamEvents.length).toBeGreaterThan(0);

    const messages = await s.h.request<MessageListResponse>("GET", `/rooms/${s.room.id}/messages`, { query: { companyId: s.company.id }, actor: s.viewer });
    const reply = messages.body.messages.find((m) => m.authorKind === "agent")!;
    expect(reply).toMatchObject({ authorId: ceo!.id, authorName: "CEO", body: "My answer" });

    const mention = await note(s, { body: "@CEO again", mentions: [ceo!.id] });
    expect(mention.status).toBe(201);
    expect(mention.body.round).toBeNull();
    expect(mention.body.ignoredMentions).toMatchObject([{ agentId: ceo!.id, reason: "removed_participant" }]);
  });

  it("answers 404 for an agent that is not an active Participant", async () => {
    const s = await setup();
    expectError(await remove(s, s.company.agents[5]!.id), 404, "participant_not_found");
    expectError(await remove(s, "nope"), 404, "participant_not_found");
    await remove(s, s.initial[0]!.id);
    expectError(await remove(s, s.initial[0]!.id), 404, "participant_not_found");
  });
});

describe("update Room", () => {
  it("changes title, topic and cap, writes old and new values and bumps updated_at", async () => {
    const s = await setup();
    s.h.streamEvents.length = 0;
    const before = s.h.activity.length;
    const response = await patch(s, { title: "  New title ", topic: "New topic", maxTotalTurns: 10 });
    expect(response.status).toBe(200);
    expect(response.body.room).toMatchObject({ title: "New title", topic: "New topic", maxTotalTurns: 10 });
    expect(Date.parse(response.body.room.updatedAt)).toBeGreaterThanOrEqual(Date.parse(s.room.updatedAt));
    const [entry, ...rest] = s.h.activity.slice(before);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ message: "Room updated", entityId: s.room.id });
    expect(entry!.metadata).toMatchObject({
      changes: {
        title: { old: "Raise prices?", new: "New title" },
        topic: { old: "Should we raise prices?", new: "New topic" },
        maxTotalTurns: { old: 40, new: 10 },
      },
      capWasReached: false,
    });
    expect(s.h.streamEvents.length).toBeGreaterThan(0);
  });

  it("changes only what is sent, and an unchanged value is no change (no activity)", async () => {
    const s = await setup();
    const before = s.h.activity.length;
    expect((await patch(s, { title: "Raise prices?" })).status).toBe(200);
    expect(s.h.activity.length).toBe(before);
    const response = await patch(s, { topic: "Only the topic" });
    expect(response.body.room).toMatchObject({ title: "Raise prices?", topic: "Only the topic", maxTotalTurns: 40 });
    expect((s.h.activity.at(-1)!.metadata as { changes: object }).changes).toEqual({ topic: { old: "Should we raise prices?", new: "Only the topic" } });
  });

  it("validates: empty body and blank text are 400, a cap outside 1 to 200 is 422", async () => {
    const s = await setup();
    expectError(await patch(s, {}), 400, "invalid_request");
    expectError(await patch(s, { title: "  " }), 400, "invalid_request");
    expectError(await patch(s, { topic: 5 }), 400, "invalid_request");
    expectError(await patch(s, { maxTotalTurns: "5" }), 400, "invalid_request");
    for (const cap of [0, 201, 1.5, -3]) expectError(await patch(s, { maxTotalTurns: cap }), 422, "turn_cap_out_of_range");
    expect((await patch(s, { maxTotalTurns: 1 })).status).toBe(200);
    expect((await patch(s, { maxTotalTurns: 200 })).status).toBe(200);
  });

  it("allows lowering the cap below the Turns already counted (it only blocks new Rounds)", async () => {
    const s = await setup({ maxTotalTurns: 5 });
    await startRound(s, [s.initial[0]!.id, s.initial[1]!.id]);
    for (const index of [0, 1]) {
      await vi.waitFor(() => expect(s.h.sessionSends.length).toBeGreaterThan(index));
      const record = s.h.sessionSends[index]!;
      s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message: `r${index}`, payload: null });
    }
    await vi.waitFor(async () => expect(await getActiveRound(s.h.ctx.db, s.company.id, s.room.id)).toBeNull());
    expect((await patch(s, { maxTotalTurns: 1 })).status).toBe(200);
    expectError(await note(s, { mentions: [s.initial[0]!.id] }), 422, "turn_cap_reached");
  });

  it("raising the cap after it was reached returns 200, flags capWasReached and lets a Round start", async () => {
    const s = await setup({ maxTotalTurns: 1 });
    await startRound(s);
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message: "ok", payload: null });
    await vi.waitFor(async () => expect(await getActiveRound(s.h.ctx.db, s.company.id, s.room.id)).toBeNull());
    expectError(await note(s, { mentions: [s.initial[0]!.id] }), 422, "turn_cap_reached");

    const response = await patch(s, { maxTotalTurns: 3 });
    expect(response.status).toBe(200);
    expect(s.h.activity.at(-1)).toMatchObject({ message: "Room updated" });
    expect(s.h.activity.at(-1)!.metadata).toMatchObject({ changes: { maxTotalTurns: { old: 1, new: 3 } }, capWasReached: true });
    expect((await note(s, { mentions: [s.initial[0]!.id] })).status).toBe(201);
  });
});

describe("close Room", () => {
  it("closes an idle Room: status, closed_at, activity, live event; reads work and writes are 409 room_closed", async () => {
    const s = await setup();
    s.h.streamEvents.length = 0;
    const before = s.h.activity.length;
    const response = await close(s);
    expect(response.status).toBe(200);
    expect(response.body.room.status).toBe("closed");
    expect(response.body.room.closedAt).not.toBeNull();
    expect(s.h.activity.slice(before).map((e) => e.message)).toEqual(["Room closed"]);
    expect(s.h.streamEvents.length).toBeGreaterThan(0);

    expectError(await note(s), 409, "room_closed");
    expectError(await note(s, { mentions: [s.initial[0]!.id] }), 409, "room_closed");
    expectError(await add(s, s.company.agents[4]!.id), 409, "room_closed");
    expectError(await remove(s, s.initial[0]!.id), 409, "room_closed");
    expectError(await patch(s, { title: "x" }), 409, "room_closed");
    expectError(await close(s), 409, "room_closed");

    const detail = await read(s);
    expect(detail.status).toBe(200);
    expect(detail.body.room.status).toBe("closed");
    const messages = await s.h.request("GET", `/rooms/${s.room.id}/messages`, { query: { companyId: s.company.id }, actor: s.viewer });
    expect(messages.status).toBe(200);
    expect((await s.h.request("GET", `/rooms/${s.room.id}/rounds`, { query: { companyId: s.company.id }, actor: s.viewer })).status).toBe(200);
  });

  it("keeps follow-up work and linking allowed after close", async () => {
    const s = await setup();
    await close(s);
    const issue = await s.h.ctx.issues.create({ companyId: s.company.id, title: "Follow up" });
    const link = await s.h.request("POST", `/rooms/${s.room.id}/work-links`, { body: { companyId: s.company.id, issueId: issue.id }, actor: s.owner });
    expect(link.status).toBe(201);
  });

  it("refuses to close during a running or paused Round, then closes after it is stopped", async () => {
    const s = await setup();
    const round = await startRound(s);
    expectError(await close(s), 409, "round_active");
    expect((await read(s)).body.room.status).toBe("open");

    await setRoundStatus(s.h.ctx.db, s.company.id, round.id, "paused", { expectedFrom: ["running"] });
    expectError(await close(s), 409, "round_active");

    await setRoundStatus(s.h.ctx.db, s.company.id, round.id, "stopped");
    expect((await close(s)).status).toBe(200);
  });
});

describe("a Round blocks membership and settings", () => {
  it("answers 409 round_active for add, remove, update and close while a Round is running or paused", async () => {
    const s = await setup();
    const round = await startRound(s);
    for (const status of ["running", "paused"] as const) {
      if (status === "paused") await setRoundStatus(s.h.ctx.db, s.company.id, round.id, "paused", { expectedFrom: ["running"] });
      expectError(await add(s, s.company.agents[4]!.id), 409, "round_active");
      expectError(await remove(s, s.initial[1]!.id), 409, "round_active");
      expectError(await patch(s, { title: "Changed" }), 409, "round_active");
      expectError(await patch(s, { topic: "Changed" }), 409, "round_active");
      expectError(await patch(s, { maxTotalTurns: 5 }), 409, "round_active");
      expectError(await close(s), 409, "round_active");
    }
    const detail = await read(s);
    expect(detail.body.room).toMatchObject({ title: "Raise prices?", status: "open" });
    expect(detail.body.participants).toHaveLength(3);
  });

  it("a Participant removed once the Round is over does not disturb the Round's history", async () => {
    const s = await setup();
    await startRound(s);
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message: "x", payload: null });
    await vi.waitFor(async () => expect(await getActiveRound(s.h.ctx.db, s.company.id, s.room.id)).toBeNull());
    expect((await remove(s, s.initial[0]!.id)).status).toBe(200);
    const rounds = await s.h.request<{ rounds: Array<{ turns: Array<{ agentName: string | null }> }> }>("GET", `/rooms/${s.room.id}/rounds`, {
      query: { companyId: s.company.id },
      actor: s.viewer,
    });
    expect(rounds.body.rounds[0]!.turns[0]!.agentName).toBe("CEO");
  });
});

describe("access", () => {
  it("an operator who is not the Owner and a viewer get 403 on all four routes", async () => {
    const s = await setup();
    const spare = s.company.agents[4]!.id;
    for (const actor of [s.operator, s.viewer]) {
      const responses = [
        await add(s, spare, actor),
        await remove(s, s.initial[0]!.id, actor),
        await patch(s, { title: "x" }, actor),
        await close(s, actor),
      ];
      for (const response of responses) expect(response.status).toBe(403);
    }
    expectError(await close(s, s.operator), 403, "control_requires_owner_or_admin");
    const detail = await read(s);
    expect(detail.body).toMatchObject({ room: { title: "Raise prices?", status: "open" } });
    expect(detail.body.participants).toHaveLength(3);
  });

  it("a company admin may use all four routes on a Room they do not own", async () => {
    const s = await setup();
    expect((await add(s, s.company.agents[4]!.id, s.admin)).status).toBe(201);
    expect((await remove(s, s.company.agents[4]!.id, s.admin)).status).toBe(200);
    expect((await patch(s, { title: "By admin" }, s.admin)).status).toBe(200);
    expect((await close(s, s.admin)).status).toBe(200);
  });

  it("a Room's operator Owner may edit their own Room", async () => {
    harness = await createBoardroomHarness({ everyCompanyConfigured: true });
    const h = harness;
    const company = await h.seedCompany({ agents: NAMES });
    const created = await h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: company.id, title: "Mine", topic: "t", agentIds: [company.agents[0]!.id] },
      actor: company.members.operator,
    });
    const response = await h.request<RoomDetail>("PATCH", `/rooms/${created.body.room.id}`, {
      body: { companyId: company.id, title: "Renamed" },
      actor: company.members.operator,
    });
    expect(response.status).toBe(200);
  });

  it("404 for an unknown Room and for a Room of another company", async () => {
    const s = await setup();
    const other = await s.h.seedCompany({ agents: ["X"] });
    const response = await s.h.request("POST", `/rooms/${s.room.id}/close`, { body: { companyId: other.id }, actor: other.members.owner });
    expectError(response, 404, "room_not_found");
    const unknown = await s.h.request("PATCH", `/rooms/${randomUUID()}`, { body: { companyId: s.company.id, title: "x" }, actor: s.owner });
    expectError(unknown, 404, "room_not_found");
  });
});
