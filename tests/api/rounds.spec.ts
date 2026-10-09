/**
 * The first Round (ticket 06): a send with a valid mention starts a Round, one Turn runs the
 * agent in a fresh session, the reply is settled once from the live session event, and the Round
 * completes. Driven through the plugin API route and the harness's session events.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { RoomDetail, RoundListResponse, SendMessageResponse } from "../../src/api/types.js";
import { listRounds, listTurns } from "../../src/db/index.js";
import { advanceRound } from "../../src/engine/rounds.js";
import { TRANSCRIPT_CHAR_BUDGET } from "../../src/engine/prompt.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: { agents?: string[]; maxTotalTurns?: number; title?: string } = {}) {
  harness = await createBoardroomHarness();
  const h = harness;
  const company = await h.seedCompany({ agents: options.agents ?? ["CEO", "CTO", "CFO"] });
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: {
      companyId: company.id,
      title: options.title ?? "Raise prices?",
      topic: "Should we raise prices by 10 percent?",
      agentIds: company.agents.map((a) => a.id),
      ...(options.maxTotalTurns ? { maxTotalTurns: options.maxTotalTurns } : {}),
    },
    actor: owner,
  });
  expect(created.status).toBe(201);

  // Spies on the session calls the worker makes (the harness fake keeps its own record of sends).
  const calls = { create: [] as Array<{ agentId: string; opts: unknown }>, close: [] as string[] };
  const sessions = h.ctx.agents.sessions;
  const create = sessions.create.bind(sessions);
  const close = sessions.close.bind(sessions);
  sessions.create = async (agentId, companyId, opts) => {
    calls.create.push({ agentId, opts });
    return create(agentId, companyId, opts);
  };
  sessions.close = async (sessionId, companyId) => {
    calls.close.push(sessionId);
    return close(sessionId, companyId);
  };
  return { h, company, room: created.body.room, owner, admin: company.members.admin, operator: company.members.operator, viewer: company.members.viewer, calls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function send(s: Setup, body: Record<string, unknown>, actor = s.owner) {
  return s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "What do you think?", ...body },
    actor,
  });
}

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((response.body as ApiErrorBody).error).toBe(code);
}

const turnsOf = (s: Setup, roundId: string) => listTurns(s.h.ctx.db, s.company.id, roundId);
const roundsOf = (s: Setup) => listRounds(s.h.ctx.db, s.company.id, s.room.id);
const agentMessages = (s: Setup) =>
  s.h.sql<{ id: string; author_id: string; body: string; round_id: string; turn_id: string; run_id: string }>(
    "SELECT * FROM plugin_boardroom_79f8e138fc.room_messages WHERE author_kind = 'agent' ORDER BY created_at, id",
  );

/** Finish the Turn that is running with a `done` event, and wait for the Round to move on. */
async function reply(s: Setup, sendIndex: number, message: string | null) {
  const record = s.h.sessionSends[sendIndex]!;
  s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message, payload: null });
  await vi.waitFor(async () => {
    const turns = (await roundsOf(s)).length > 0 ? await turnsOf(s, (await roundsOf(s)).at(-1)!.id) : [];
    expect(turns.find((t) => t.runId === record.runId)?.status).toBe("finished");
  });
}

describe("starting a Round", () => {
  it("runs one Turn for one mentioned Participant in a new session", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    const response = await send(s, { body: "@CEO should we?", mentions: [ceo.id] });
    expect(response.status).toBe(201);
    expect(response.body.round).toMatchObject({ status: "running", seq: 1, addressedAgentIds: [ceo.id], startedByUserId: s.owner.userId });
    expect(response.body.round!.turns).toMatchObject([{ agentId: ceo.id, agentName: "CEO", ord: 1, status: "running", outcome: null }]);

    expect(s.calls.create).toHaveLength(1);
    expect(s.calls.create[0]).toMatchObject({ agentId: ceo.id, opts: { reason: "Boardroom: Raise prices?" } });
    expect(s.h.sessionSends).toHaveLength(1);
    expect(s.h.sessionSends[0]).toMatchObject({ agentId: ceo.id, reason: "Boardroom: Raise prices?" });
    const [turn] = await turnsOf(s, response.body.round!.id);
    expect(turn).toMatchObject({ status: "running", sessionId: s.h.sessionSends[0]!.sessionId, runId: s.h.sessionSends[0]!.runId });
    // The Room detail carries the active Round with its Turns.
    const detail = await s.h.request<RoomDetail>("GET", `/rooms/${s.room.id}`, { query: { companyId: s.company.id }, actor: s.viewer });
    expect(detail.body.activeRound).toMatchObject({ id: response.body.round!.id, turns: [{ agentName: "CEO", status: "running" }] });
  });

  it("gives the agent the topic, the Participants with roles, who was addressed, the four rules and the recent Messages", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    await send(s, { body: "Earlier note from the board." });
    await send(s, { body: "@CTO what about margins?", mentions: [cto!.id] });
    const prompt = s.h.sessionSends[0]!.prompt;
    expect(s.h.sessionSends[0]!.agentId).toBe(cto!.id);
    expect(prompt).toContain("Should we raise prices by 10 percent?");
    expect(prompt).toContain("Raise prices?");
    for (const agent of s.company.agents) expect(prompt).toContain(`- ${agent.name} (`);
    expect(prompt).toMatch(/Addressed in this round: CTO/);
    expect(prompt).toContain("Reply with only your Message.");
    expect(prompt).toContain("You may disagree.");
    expect(prompt).toContain("Do not describe your environment.");
    expect(prompt).toContain("Do not call Paperclip APIs or create work during this turn.");
    expect(prompt).toContain("Earlier note from the board.");
    expect(prompt.indexOf("Earlier note")).toBeLessThan(prompt.indexOf("@CTO what about margins?"));
    expect(prompt).not.toContain("left out");
    expect(ceo).toBeDefined();
  });

  it("keeps a long history near 12,000 characters and says how many Messages were left out", async () => {
    const s = await setup();
    const cto = s.company.agents[1]!;
    await s.h.sql(
      `INSERT INTO plugin_boardroom_79f8e138fc.room_messages (id, company_id, room_id, author_kind, author_id, body, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'user', $3, 'old ' || g || ' ' || repeat('x', 500), '2026-10-01T09:00:00Z'::timestamptz + g * interval '1 second'
       FROM generate_series(1, 100) g`,
      [s.company.id, s.room.id, s.owner.userId],
    );
    await send(s, { body: "@CTO latest question", mentions: [cto.id] });
    const prompt = s.h.sessionSends[0]!.prompt;
    const transcript = prompt.slice(prompt.indexOf("Transcript"));
    expect(transcript.length).toBeLessThan(TRANSCRIPT_CHAR_BUDGET + 400);
    expect(transcript.length).toBeGreaterThan(TRANSCRIPT_CHAR_BUDGET - 1500);
    const left = /(\d+) older messages were left out/.exec(prompt);
    expect(left).not.toBeNull();
    const shown = (transcript.match(/^\[(Owner|Board member|[A-Z]+)\]$/gm) ?? []).length;
    expect(Number(left![1]) + shown).toBe(101);
    expect(prompt).toContain("latest question");
    expect(prompt).not.toContain("old 1 x");
  });

  it("runs the Turns one after the other, in the order mentioned", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const response = await send(s, { body: "@CTO @CEO go", mentions: [cto!.id, ceo!.id] });
    expect(response.body.round!.addressedAgentIds).toEqual([cto!.id, ceo!.id]);
    expect(response.body.round!.turns.map((t) => [t.agentName, t.status])).toEqual([["CTO", "running"], ["CEO", "queued"]]);
    expect(s.h.sessionSends).toHaveLength(1);
    await reply(s, 0, "CTO says yes");
    await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(2));
    expect(s.h.sessionSends[1]!.agentId).toBe(ceo!.id);
    // The second agent sees the first one's reply.
    expect(s.h.sessionSends[1]!.prompt).toContain("CTO says yes");
    expect(s.calls.create).toHaveLength(2);
  });
});

describe("settling a Turn", () => {
  it("posts the reply as an attributed Message, completes the Round and closes the session", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    const started = await send(s, { body: "@CEO should we?", mentions: [ceo.id] });
    await reply(s, 0, "Yes, by 5 percent.");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));

    const [message] = await agentMessages(s);
    const [turn] = await turnsOf(s, started.body.round!.id);
    expect(message).toMatchObject({ author_id: ceo.id, body: "Yes, by 5 percent.", round_id: started.body.round!.id, turn_id: turn!.id, run_id: s.h.sessionSends[0]!.runId });
    expect(turn).toMatchObject({ status: "finished", outcome: "posted", messageId: message!.id });
    expect(s.calls.close).toEqual([s.h.sessionSends[0]!.sessionId]);

    const page = await s.h.request<{ messages: Array<{ authorName: string | null; runId: string | null }> }>("GET", `/rooms/${s.room.id}/messages`, {
      query: { companyId: s.company.id },
      actor: s.viewer,
    });
    expect(page.body.messages.at(-1)).toMatchObject({ authorName: "CEO", runId: s.h.sessionSends[0]!.runId });
    const detail = await s.h.request<RoomDetail>("GET", `/rooms/${s.room.id}`, { query: { companyId: s.company.id }, actor: s.viewer });
    expect(detail.body.activeRound).toBeNull();
  });

  it("makes an empty or blank reply silent, with no Message", async () => {
    const s = await setup();
    const started = await send(s, { body: "@CEO anything?", mentions: [s.company.agents[0]!.id] });
    await reply(s, 0, "   \n ");
    const [turn] = await turnsOf(s, started.body.round!.id);
    expect(turn).toMatchObject({ status: "finished", outcome: "silent", messageId: null });
    expect(await agentMessages(s)).toEqual([]);
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    expect(s.calls.close).toHaveLength(1);
  });

  it("makes a done event with no text silent too", async () => {
    const s = await setup();
    const started = await send(s, { body: "@CEO anything?", mentions: [s.company.agents[0]!.id] });
    await reply(s, 0, null);
    expect((await turnsOf(s, started.body.round!.id))[0]).toMatchObject({ outcome: "silent" });
  });

  it("makes an error event failed, with no Message, and still completes the Round", async () => {
    const s = await setup();
    const started = await send(s, { body: "@CEO anything?", mentions: [s.company.agents[0]!.id] });
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "error", stream: null, message: "adapter crashed", payload: null });
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    expect((await turnsOf(s, started.body.round!.id))[0]).toMatchObject({ status: "finished", outcome: "failed", hostMessage: "adapter crashed" });
    expect(await agentMessages(s)).toEqual([]);
  });

  it("ignores chunk and status events", async () => {
    const s = await setup();
    const started = await send(s, { body: "@CEO anything?", mentions: [s.company.agents[0]!.id] });
    const record = s.h.sessionSends[0]!;
    for (const eventType of ["chunk", "status"] as const) {
      s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType, stream: "stdout", message: "partial", payload: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await turnsOf(s, started.body.round!.id))[0]!.status).toBe("running");
  });

  it("settles once: a second done changes nothing", async () => {
    const s = await setup();
    await send(s, { body: "@CEO should we?", mentions: [s.company.agents[0]!.id] });
    const record = s.h.sessionSends[0]!;
    const done = { runId: record.runId!, seq: 2, eventType: "done" as const, stream: null, message: "First answer", payload: null };
    s.h.simulateSessionEvent(record.sessionId, done);
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    const entriesBefore = s.h.activity.length;
    // The fake drops callbacks when a session closes, so call the handler the way a late signal would.
    const { settleTurn } = await import("../../src/engine/rounds.js");
    const [turn] = await turnsOf(s, (await roundsOf(s))[0]!.id);
    expect(await settleTurn(s.h.ctx, s.company.id, turn!.id, { outcome: "posted", text: "Second answer", runId: record.runId })).toBe(false);
    expect(await settleTurn(s.h.ctx, s.company.id, turn!.id, { outcome: "failed" })).toBe(false);
    expect(await agentMessages(s)).toHaveLength(1);
    expect((await agentMessages(s))[0]!.body).toBe("First answer");
    expect(s.h.activity.length).toBe(entriesBefore);
    expect((await turnsOf(s, turn!.roundId))[0]!.outcome).toBe("posted");
  });

  it("settles once when two completion signals race", async () => {
    const s = await setup();
    await send(s, { body: "@CEO should we?", mentions: [s.company.agents[0]!.id] });
    const record = s.h.sessionSends[0]!;
    const { settleTurn } = await import("../../src/engine/rounds.js");
    const [turn] = await turnsOf(s, (await roundsOf(s))[0]!.id);
    const results = await Promise.all([
      settleTurn(s.h.ctx, s.company.id, turn!.id, { outcome: "posted", text: "A", runId: record.runId }),
      settleTurn(s.h.ctx, s.company.id, turn!.id, { outcome: "posted", text: "B", runId: record.runId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await agentMessages(s)).toHaveLength(1);
    expect(s.h.activity.filter((e) => e.message === "Turn posted")).toHaveLength(1);
  });

  it("gives each Turn a new session, also for the same agent in a later Round", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    await send(s, { body: "@CEO round one", mentions: [ceo.id] });
    await reply(s, 0, "One");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    const second = await send(s, { body: "@CEO round two", mentions: [ceo.id] });
    expect(second.status).toBe(201);
    expect(second.body.round!.seq).toBe(2);
    expect(s.calls.create).toHaveLength(2);
    expect(s.h.sessionSends[0]!.sessionId).not.toBe(s.h.sessionSends[1]!.sessionId);
  });

  it("skips a Turn when the host refuses the send, and the Round continues", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    s.h.failNextSend(new Error("Agent is paused"));
    const response = await send(s, { body: "@CEO @CTO go", mentions: [ceo!.id, cto!.id] });
    expect(response.status).toBe(201);
    const turns = await turnsOf(s, response.body.round!.id);
    expect(turns.map((t) => [t.status, t.outcome])).toEqual([["finished", "skipped"], ["running", null]]);
    expect(turns[0]).toMatchObject({ skipReason: "not_invokable", hostMessage: "Agent is paused" });
    expect(s.calls.close).toHaveLength(1);
  });
});

describe("Round rules", () => {
  it("answers 409 round_active while a Round is running, and saves nothing", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    await send(s, { body: "@CEO first", mentions: [ceo!.id] });
    const before = await s.h.sql("SELECT id FROM plugin_boardroom_79f8e138fc.room_messages");
    expectError(await send(s, { body: "@CTO second", mentions: [cto!.id] }), 409, "round_active");
    expect(await s.h.sql("SELECT id FROM plugin_boardroom_79f8e138fc.room_messages")).toHaveLength(before.length);
    // A plain note is still fine during a Round.
    expect((await send(s, { body: "just a note" })).status).toBe(201);
  });

  it("refuses a Round that would pass the turn cap with 422 turn_cap_reached", async () => {
    const s = await setup({ maxTotalTurns: 1 });
    const [ceo, cto] = s.company.agents;
    await send(s, { body: "@CEO one", mentions: [ceo!.id] });
    await reply(s, 0, "ok");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    const refused = await send(s, { body: "@CTO two", mentions: [cto!.id] });
    expectError(refused, 422, "turn_cap_reached");
    expect((refused.body as unknown as ApiErrorBody).details).toMatchObject({ cap: 1, counted: 1, requested: 1 });
    expect(await roundsOf(s)).toHaveLength(1);
  });

  it("counts every new Turn against the cap", async () => {
    const s = await setup({ maxTotalTurns: 1 });
    const [ceo, cto] = s.company.agents;
    expectError(await send(s, { body: "@CEO @CTO", mentions: [ceo!.id, cto!.id] }), 422, "turn_cap_reached");
  });

  it("does not count Turns skipped before their run started", async () => {
    const s = await setup({ maxTotalTurns: 1 });
    const ceo = s.company.agents[0]!;
    const first = await send(s, { body: "@CEO one", mentions: [ceo.id] });
    await reply(s, 0, "ok");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    await s.h.sql("UPDATE plugin_boardroom_79f8e138fc.turns SET outcome = 'skipped', skip_reason = 'not_invokable' WHERE round_id = $1", [first.body.round!.id]);
    expect((await send(s, { body: "@CEO again", mentions: [ceo.id] })).status).toBe(201);
  });

  it("refuses an operator who mentions an agent with 403 and saves nothing; an admin who is not the Owner can start a Round", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    expectError(await send(s, { body: "@CEO please", mentions: [ceo.id] }, s.operator), 403, "round_not_allowed");
    expect(await s.h.sql("SELECT id FROM plugin_boardroom_79f8e138fc.room_messages")).toEqual([]);
    expect(await roundsOf(s)).toEqual([]);
    expect(s.h.sessionSends).toEqual([]);
    // An operator's plain note still works.
    expect((await send(s, { body: "just a note" }, s.operator)).status).toBe(201);

    const admin = await send(s, { body: "@CEO please", mentions: [ceo.id] }, s.admin);
    expect(admin.status).toBe(201);
    expect(admin.body.round).toMatchObject({ status: "running", startedByUserId: s.admin.userId });
  });

  it("lets a Room Owner who is an operator start a Round", async () => {
    harness = await createBoardroomHarness();
    const company = await harness.seedCompany({ agents: ["CEO"] });
    const created = await harness.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: company.id, title: "T", topic: "T", agentIds: [company.agents[0]!.id] },
      actor: company.members.operator,
    });
    const response = await harness.request<SendMessageResponse>("POST", `/rooms/${created.body.room.id}/messages`, {
      body: { companyId: company.id, idempotencyKey: randomUUID(), body: "@CEO hi", mentions: [company.agents[0]!.id] },
      actor: company.members.operator,
    });
    expect(response.status).toBe(201);
    expect(response.body.round?.status).toBe("running");
  });

  it("returns the original Round on a replayed idempotency key and starts nothing", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    const key = randomUUID();
    const first = await send(s, { idempotencyKey: key, body: "@CEO go", mentions: [ceo.id] });
    expect(first.status).toBe(201);
    const again = await send(s, { idempotencyKey: key, body: "@CEO go", mentions: [ceo.id] });
    expect(again.status).toBe(200);
    expect(again.body.round).toMatchObject({ id: first.body.round!.id, seq: 1, status: "running" });
    expect(again.body.round!.turns).toHaveLength(1);
    expect(await roundsOf(s)).toHaveLength(1);
    expect(s.calls.create).toHaveLength(1);
    expect(s.h.sessionSends).toHaveLength(1);
  });

  it("keeps a note with only ignored mentions a note", async () => {
    const s = await setup();
    const response = await send(s, { body: "@Nobody", mentions: [randomUUID()] }, s.operator);
    expect(response.status).toBe(201);
    expect(response.body.round).toBeNull();
  });
});

describe("advanceRound", () => {
  it("starts no second Turn when called twice at once", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const started = await send(s, { body: "@CEO @CTO", mentions: [ceo!.id, cto!.id] });
    await Promise.all([advanceRound(s.h.ctx, s.company.id, started.body.round!.id), advanceRound(s.h.ctx, s.company.id, started.body.round!.id)]);
    expect(s.h.sessionSends).toHaveLength(1);
  });

  it("leaves a paused Round alone", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const started = await send(s, { body: "@CEO @CTO", mentions: [ceo!.id, cto!.id] });
    await s.h.sql("UPDATE plugin_boardroom_79f8e138fc.rounds SET status = 'paused' WHERE id = $1", [started.body.round!.id]);
    await reply(s, 0, "done");
    expect(s.h.sessionSends).toHaveLength(1);
    expect((await turnsOf(s, started.body.round!.id)).map((t) => t.status)).toEqual(["finished", "queued"]);
  });
});

describe("Round history", () => {
  it("lists Rounds newest first with their Turns, for a viewer", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    await send(s, { body: "@CEO one", mentions: [ceo!.id] });
    await reply(s, 0, "reply one");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    await send(s, { body: "@CTO two", mentions: [cto!.id] });
    const list = await s.h.request<RoundListResponse>("GET", `/rooms/${s.room.id}/rounds`, { query: { companyId: s.company.id }, actor: s.viewer });
    expect(list.status).toBe(200);
    expect(list.body.rounds.map((r) => [r.seq, r.status])).toEqual([[2, "running"], [1, "completed"]]);
    expect(list.body.rounds[1]!.turns[0]).toMatchObject({
      agentId: ceo!.id, agentName: "CEO", ord: 1, status: "finished", outcome: "posted", skipReason: null, hostMessage: null,
      runId: s.h.sessionSends[0]!.runId,
    });
    expect(list.body.rounds[1]!.turns[0]!.messageId).toEqual(expect.any(String));
    expect(JSON.stringify(list.body)).not.toContain("sessionId");
  });

  it("answers 404 for another company's Room and an unknown Room", async () => {
    const s = await setup();
    const other = await s.h.seedCompany();
    expectError(await s.h.request("GET", `/rooms/${s.room.id}/rounds`, { query: { companyId: other.id }, actor: other.members.owner }), 404, "room_not_found");
    expectError(await s.h.request("GET", `/rooms/${randomUUID()}/rounds`, { query: { companyId: s.company.id }, actor: s.owner }), 404, "room_not_found");
  });
});

describe("activity, live updates and Room freshness", () => {
  it("writes Round started, each Turn outcome and Round completed, with agent and run ids", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const before = s.h.activity.length;
    const started = await send(s, { body: "@CEO @CTO", mentions: [ceo!.id, cto!.id] });
    await reply(s, 0, "from CEO");
    await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(2));
    await reply(s, 1, "");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));

    const entries = s.h.activity.slice(before);
    expect(entries.map((e) => e.message)).toEqual(["Message posted", "Round started", "Turn posted", "Turn silent", "Round completed"]);
    expect(entries[1]!.metadata).toMatchObject({ actingUserId: s.owner.userId, roundId: started.body.round!.id, addressedAgentIds: [ceo!.id, cto!.id] });
    expect(entries[2]!.metadata).toMatchObject({ agentId: ceo!.id, runId: s.h.sessionSends[0]!.runId, outcome: "posted", actingUserId: null });
    expect(entries[3]!.metadata).toMatchObject({ agentId: cto!.id, runId: s.h.sessionSends[1]!.runId, outcome: "silent" });
    expect(entries[4]!.metadata).toMatchObject({ roundId: started.body.round!.id, actingUserId: null });
    expect(JSON.stringify(entries.map((e) => e.metadata))).not.toContain("from CEO");
  });

  it("emits room.changed after each state change and bumps the Room", async () => {
    const s = await setup();
    const before = s.h.streamEvents.length;
    const updatedBefore = (await s.h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms"))[0]!.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(s, { body: "@CEO go", mentions: [s.company.agents[0]!.id] });
    const afterStart = s.h.streamEvents.length;
    expect(afterStart - before).toBeGreaterThanOrEqual(2);
    await reply(s, 0, "answer");
    await vi.waitFor(async () => expect((await roundsOf(s))[0]!.status).toBe("completed"));
    expect(s.h.streamEvents.length).toBeGreaterThan(afterStart);
    for (const e of s.h.streamEvents.slice(before)) expect(e.event).toMatchObject({ type: "room.changed", roomId: s.room.id });
    const updatedAfter = (await s.h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms"))[0]!.updated_at;
    expect(new Date(updatedAfter).getTime()).toBeGreaterThan(new Date(updatedBefore).getTime());
  });
});

describe("multi-agent Rounds (ticket 07)", () => {
  const settled = async (s: Setup, roundId: string) =>
    vi.waitFor(async () => expect((await roundsOf(s)).find((r) => r.id === roundId)?.status).toBe("completed"));
  const names = (s: Setup, ids: string[]) => ids.map((id) => s.company.agents.find((a) => a.id === id)!.name);

  it("runs B then A for mentions B, A, B: two Turns, only B's session until B settles", async () => {
    const s = await setup();
    const [a, b] = s.company.agents;
    const response = await send(s, { body: "@CTO @CEO @CTO", mentions: [b!.id, a!.id, b!.id] });
    expect(response.body.round!.turns.map((t) => t.agentId)).toEqual([b!.id, a!.id]);
    expect(s.calls.create.map((c) => c.agentId)).toEqual([b!.id]);
    await reply(s, 0, "B says");
    await vi.waitFor(() => expect(s.calls.create.map((c) => c.agentId)).toEqual([b!.id, a!.id]));
    await reply(s, 1, "A says");
    await settled(s, response.body.round!.id);
    expect(s.calls.create).toHaveLength(2);
  });

  it("Ask all runs every active Participant in join order and ignores mentions", async () => {
    const s = await setup();
    const [a, b, c] = s.company.agents;
    const response = await send(s, { body: "@CFO everyone please", mentions: [c!.id], askAll: true });
    expect(response.status).toBe(201);
    expect(response.body.round).toMatchObject({ askAll: true });
    expect(response.body.round!.turns.map((t) => t.agentId)).toEqual([a!.id, b!.id, c!.id]);
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(i + 1));
      await reply(s, i, `reply ${i}`);
    }
    await settled(s, response.body.round!.id);
    expect(s.calls.create.map((x) => x.agentId)).toEqual([a!.id, b!.id, c!.id]);
  });

  it("Ask all counts the full set against the cap", async () => {
    const s = await setup({ maxTotalTurns: 2 });
    expectError(await send(s, { body: "everyone", askAll: true }), 422, "turn_cap_reached");
    expect(s.h.sessionSends).toEqual([]);
  });

  it("refuses Ask all from an operator", async () => {
    const s = await setup();
    expectError(await send(s, { body: "everyone", askAll: true }, s.operator), 403, "round_not_allowed");
  });

  it("puts the first agent's Message in the second agent's prompt", async () => {
    const s = await setup();
    const [a, b] = s.company.agents;
    await send(s, { body: "both", mentions: [a!.id, b!.id] });
    expect(s.h.sessionSends[0]!.prompt).not.toContain("Margins are fine");
    await reply(s, 0, "Margins are fine");
    await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(2));
    expect(s.h.sessionSends[1]!.agentId).toBe(b!.id);
    expect(s.h.sessionSends[1]!.prompt).toContain("Margins are fine");
  });

  it("moves on after a failed Turn and completes the Round", async () => {
    const s = await setup();
    const [a, b] = s.company.agents;
    const response = await send(s, { body: "both", mentions: [a!.id, b!.id] });
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "error", stream: null, message: "boom", payload: null });
    await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(2));
    await reply(s, 1, "fine");
    await settled(s, response.body.round!.id);
    expect((await turnsOf(s, response.body.round!.id)).map((t) => t.outcome)).toEqual(["failed", "posted"]);
  });

  it("skips a rejected send with the host's exact text, advances, and does not count it", async () => {
    const s = await setup({ maxTotalTurns: 2 });
    const [a, b] = s.company.agents;
    s.h.failSends((x) => x.agentId === a!.id, () => new Error("Agent is over budget (limit $5.00)"));
    const response = await send(s, { body: "both", mentions: [a!.id, b!.id] });
    const [first, second] = await turnsOf(s, response.body.round!.id);
    expect(first).toMatchObject({ status: "finished", outcome: "skipped", skipReason: "not_invokable", hostMessage: "Agent is over budget (limit $5.00)" });
    expect(second!.status).toBe("running");
    expect(s.calls.close).toHaveLength(1);
    s.h.clearSendFailures();
    await reply(s, 1, "ok");
    await settled(s, response.body.round!.id);
    const skipped = s.h.activity.filter((e) => e.message === "Turn skipped");
    expect(skipped).toHaveLength(1);
    expect(JSON.stringify(skipped[0])).toContain("Agent is over budget (limit $5.00)");
    // Cap 2: one skipped and one posted; a new Round of one Turn is accepted.
    expect((await send(s, { body: "@CEO again", mentions: [a!.id] })).status).toBe(201);
    expect(names(s, [a!.id])).toEqual(["CEO"]);
  });

  it("never creates a second session for the same (Round, agent)", async () => {
    const s = await setup();
    const [a, b] = s.company.agents;
    const response = await send(s, { body: "both", mentions: [a!.id, b!.id] });
    await reply(s, 0, "one");
    await vi.waitFor(() => expect(s.h.sessionSends).toHaveLength(2));
    await reply(s, 1, "two");
    await settled(s, response.body.round!.id);
    await advanceRound(s.h.ctx, s.company.id, response.body.round!.id);
    expect(s.calls.create.map((c) => c.agentId)).toEqual([a!.id, b!.id]);
  });

  it("accepts a retry Round to the same agent after a failed Turn", async () => {
    const s = await setup();
    const a = s.company.agents[0]!;
    const first = await send(s, { body: "@CEO", mentions: [a.id] });
    const record = s.h.sessionSends[0]!;
    s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "error", stream: null, message: "boom", payload: null });
    await settled(s, first.body.round!.id);
    const second = await send(s, { body: "@CEO retry", mentions: [a.id] });
    expect(second.status).toBe(201);
    expect(second.body.round!.seq).toBe(2);
    expect(s.calls.create).toHaveLength(2);
  });
});
