/**
 * Notes and the transcript (ticket 05): the send endpoint (idempotency, mention parsing, closed
 * Rooms, activity and live events) and the paged transcript, through the plugin API route.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/api/errors.js";
import { findHandTypedMentions } from "../../src/api/mentions.js";
import { ROUTE_SPECS } from "../../src/api/route-table.js";
import type {
  MessageListResponse,
  RoomDetail,
  RoomListResponse,
  SendMessageResponse,
} from "../../src/api/types.js";
import { insertMessage, insertRound, insertTurn, listRounds, removeParticipant } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: { agents?: string[] } = {}) {
  harness = await createBoardroomHarness();
  const h = harness;
  const company = await h.seedCompany(options.agents ? { agents: options.agents } : undefined);
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title: "Raise prices?", topic: "Should we?", agentIds: company.agents.slice(0, 2).map((a) => a.id) },
    actor: owner,
  });
  return { h, company, room: created.body.room, owner, operator: company.members.operator, viewer: company.members.viewer };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function send(s: Setup, body: Record<string, unknown>, actor = s.operator, roomId = s.room.id) {
  return s.h.request<SendMessageResponse>("POST", `/rooms/${roomId}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "hello", ...body },
    actor,
  });
}

function transcript(s: Setup, query: Record<string, string> = {}, actor = s.viewer, roomId = s.room.id) {
  return s.h.request<MessageListResponse>("GET", `/rooms/${roomId}/messages`, {
    query: { companyId: s.company.id, ...query },
    actor,
  });
}

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((response.body as ApiErrorBody).error).toBe(code);
}

const messageRows = (s: Setup) => s.h.sql("SELECT id FROM plugin_boardroom_79f8e138fc.room_messages");

describe("POST /rooms/:roomId/messages", () => {
  it("lets an operator post a note, attributed to them, with no Round", async () => {
    const s = await setup();
    const response = await send(s, { body: "We should look at **costs** first." });
    expect(response.status).toBe(201);
    expect(response.body.round).toBeNull();
    expect(response.body.ignoredMentions).toEqual([]);
    expect(response.body.message).toMatchObject({
      roomId: s.room.id,
      authorKind: "user",
      authorId: s.operator.userId,
      body: "We should look at **costs** first.",
      roundId: null,
      turnId: null,
      runId: null,
    });

    const page = await transcript(s);
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.messages[0]).toEqual(response.body.message);
    expect(page.body.hasMore).toBe(false);
  });

  it("saves a note and starts no Round even with valid mentions or askAll (ticket 06 changes that)", async () => {
    const s = await setup();
    const [first] = s.company.agents;
    const response = await send(s, { body: "@CEO what do you think?", mentions: [first!.id], askAll: true });
    expect(response.status).toBe(201);
    expect(response.body.round).toBeNull();
    expect(response.body.ignoredMentions).toEqual([]);
    expect(await listRounds(s.h.ctx.db, s.company.id, s.room.id)).toEqual([]);
    expect(s.h.sessionSends).toEqual([]);
  });

  it("refuses a viewer with 403 on send and lets them read the transcript", async () => {
    const s = await setup();
    await send(s, { body: "visible to all" });
    const refused = await send(s, {}, s.viewer);
    expect(refused.status).toBe(403);
    // The host stops a viewer first; the plugin applies the same rule when called directly.
    const direct = await callWorker(s, "messages.send", s.viewer.userId, {
      body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "x" },
    });
    expectError(direct, 403, "role_cannot_post");
    expect(await messageRows(s)).toHaveLength(1);

    const read = await transcript(s, {}, s.viewer);
    expect(read.status).toBe(200);
    expect(read.body.messages.map((m) => m.body)).toEqual(["visible to all"]);
    expect(s.h.activity.filter((e) => e.message === "Message posted")).toHaveLength(1);
  });

  it("works for the local board user and for a company owner", async () => {
    const s = await setup();
    const local = await s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
      body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "from local" },
    });
    expect(local.body.message.authorId).toBe("local-board");
    const owner = await send(s, { body: "from owner" }, s.owner);
    expect(owner.body.message.authorId).toBe(s.owner.userId);
  });

  it("returns an agent's mention in ignoredMentions with a reason, and still saves the note", async () => {
    const s = await setup({ agents: ["CEO", "CTO", "CFO"] });
    const [ceo, , cfo] = s.company.agents;
    const stranger = s.company.agents[2]!;
    const other = await s.h.seedCompany();
    const foreign = other.agents[0]!;
    const ghost = randomUUID();

    const response = await send(s, {
      body: "@CEO and @CFO and others",
      mentions: [ceo!.id, stranger.id, foreign.id, ghost, "not-an-id"],
    });
    expect(response.status).toBe(201);
    expect(response.body.message.body).toBe("@CEO and @CFO and others");
    expect(response.body.ignoredMentions).toEqual([
      { agentId: cfo!.id, name: "CFO", reason: "not_a_participant" },
      { agentId: foreign.id, name: null, reason: "unknown_agent" },
      { agentId: ghost, name: null, reason: "unknown_agent" },
      { agentId: "not-an-id", name: null, reason: "unknown_agent" },
    ]);
    expect(await messageRows(s)).toHaveLength(1);
  });

  it("ignores a removed Participant with reason removed_participant", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    await removeParticipant(s.h.ctx.db, s.company.id, s.room.id, cto!.id);
    const response = await send(s, { body: "@CEO @CTO", mentions: [cto!.id, ceo!.id, cto!.id.toUpperCase()] });
    expect(response.body.ignoredMentions).toEqual([{ agentId: cto!.id, name: "CTO", reason: "removed_participant" }]);
  });

  it("reports a repeated invalid mention once", async () => {
    const s = await setup({ agents: ["CEO", "CTO", "CFO"] });
    const cfo = s.company.agents[2]!;
    const response = await send(s, { mentions: [cfo.id, cfo.id] });
    expect(response.body.ignoredMentions).toHaveLength(1);
  });

  it("answers 400 invalid_request when the idempotency key is missing or blank", async () => {
    const s = await setup();
    const call = (body: Record<string, unknown>) =>
      s.h.request("POST", `/rooms/${s.room.id}/messages`, { body: { companyId: s.company.id, body: "hi", ...body }, actor: s.operator });
    expectError(await call({}), 400, "invalid_request");
    expectError(await call({ idempotencyKey: "   " }), 400, "invalid_request");
    expectError(await call({ idempotencyKey: 7 }), 400, "invalid_request");
    expectError(await call({ idempotencyKey: "k".repeat(201) }), 400, "invalid_request");
    expect(await messageRows(s)).toEqual([]);
  });

  it("answers 400 invalid_request for a bad body, mentions or askAll", async () => {
    const s = await setup();
    expectError(await send(s, { body: "   " }), 400, "invalid_request");
    expectError(await send(s, { body: 5 }), 400, "invalid_request");
    expectError(await send(s, { body: "x".repeat(20_001) }), 400, "invalid_request");
    expectError(await send(s, { mentions: "all" }), 400, "invalid_request");
    expectError(await send(s, { mentions: [1] }), 400, "invalid_request");
    expectError(await send(s, { mentions: Array.from({ length: 51 }, () => randomUUID()) }), 400, "invalid_request");
    expectError(await send(s, { askAll: "yes" }), 400, "invalid_request");
    expect(await messageRows(s)).toEqual([]);
    // Boundary values are accepted.
    expect((await send(s, { body: "x".repeat(20_000), mentions: null, askAll: null })).status).toBe(201);
  });

  it("answers 404 for a Room of another company or one that does not exist", async () => {
    const s = await setup();
    const other = await s.h.seedCompany();
    const foreign = await s.h.request("POST", `/rooms/${s.room.id}/messages`, {
      body: { companyId: other.id, idempotencyKey: randomUUID(), body: "x" },
      actor: other.members.operator,
    });
    expectError(foreign, 404, "room_not_found");
    expectError(await send(s, {}, s.operator, randomUUID()), 404, "room_not_found");
    expectError(await send(s, {}, s.operator, "nope"), 404, "room_not_found");
    expectError(await transcript(s, {}, s.viewer, randomUUID()), 404, "room_not_found");
    const foreignRead = await s.h.request("GET", `/rooms/${s.room.id}/messages`, {
      query: { companyId: other.id },
      actor: other.members.viewer,
    });
    expectError(foreignRead, 404, "room_not_found");
  });

  it("stores quotes, unicode and SQL metacharacters unchanged", async () => {
    const s = await setup();
    const body = `It's "quoted"; DROP TABLE rooms; -- $1 ${"\u{1F680}"} \\ ünï`;
    const response = await send(s, { body });
    expect(response.body.message.body).toBe(body);
    expect((await transcript(s)).body.messages[0]!.body).toBe(body);
  });
});

describe("idempotency", () => {
  it("returns the same Message with 200 for a repeated key and creates nothing", async () => {
    const s = await setup();
    const key = "send-1";
    const first = await send(s, { idempotencyKey: key, body: "once" });
    expect(first.status).toBe(201);
    const activityBefore = s.h.activity.length;
    const eventsBefore = s.h.streamEvents.length;

    const again = await send(s, { idempotencyKey: key, body: "once" });
    expect(again.status).toBe(200);
    expect(again.body.message.id).toBe(first.body.message.id);
    expect(again.body).toEqual(first.body);
    expect((await transcript(s)).body.messages).toHaveLength(1);
    expect(await messageRows(s)).toHaveLength(1);
    // No activity entry and no live event for the replay.
    expect(s.h.activity).toHaveLength(activityBefore);
    expect(s.h.streamEvents).toHaveLength(eventsBefore);
  });

  it("returns the original Message even when the repeated body differs", async () => {
    const s = await setup();
    const first = await send(s, { idempotencyKey: "k", body: "first" });
    const again = await send(s, { idempotencyKey: "k", body: "edited" });
    expect(again.status).toBe(200);
    expect(again.body.message).toMatchObject({ id: first.body.message.id, body: "first" });
  });

  it("recomputes the ignored mentions on a replay (they are not stored)", async () => {
    const s = await setup({ agents: ["CEO", "CTO", "CFO"] });
    const cfo = s.company.agents[2]!;
    const first = await send(s, { idempotencyKey: "k", mentions: [cfo.id] });
    const again = await send(s, { idempotencyKey: "k", mentions: [cfo.id] });
    expect(again.status).toBe(200);
    expect(again.body.ignoredMentions).toEqual(first.body.ignoredMentions);
    expect(again.body.ignoredMentions).toHaveLength(1);
  });

  it("scopes a key to its Room", async () => {
    const s = await setup();
    const second = await s.h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: s.company.id, title: "Other", topic: "Other topic", agentIds: [s.company.agents[0]!.id] },
      actor: s.owner,
    });
    const a = await send(s, { idempotencyKey: "same", body: "A" });
    const b = await send(s, { idempotencyKey: "same", body: "B" }, s.operator, second.body.room.id);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.message.id).not.toBe(a.body.message.id);
  });

  it("refuses another user's key with 409 idempotency_key_in_use and does not leak the Message", async () => {
    const s = await setup();
    await send(s, { idempotencyKey: "taken", body: "private" }, s.operator);
    const clash = await send(s, { idempotencyKey: "taken", body: "mine" }, s.owner);
    expectError(clash, 409, "idempotency_key_in_use");
    expect(JSON.stringify(clash.body)).not.toContain("private");
    expect(await messageRows(s)).toHaveLength(1);
  });

  it("collapses two concurrent sends with one key into one Message", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([send(s, { idempotencyKey: "race" }), send(s, { idempotencyKey: "race" })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.message.id).toBe(b.body.message.id);
    expect(await messageRows(s)).toHaveLength(1);
    expect(s.h.activity.filter((e) => e.message === "Message posted")).toHaveLength(1);
  });
});

describe("closed Rooms", () => {
  async function closeRoom(s: Setup) {
    await s.h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET status = 'closed', closed_at = now() WHERE id = $1", [s.room.id]);
  }

  it("answers 409 room_closed and saves nothing", async () => {
    const s = await setup();
    await closeRoom(s);
    const activityBefore = s.h.activity.length;
    const eventsBefore = s.h.streamEvents.length;
    expectError(await send(s, {}), 409, "room_closed");
    expect(await messageRows(s)).toEqual([]);
    expect(s.h.activity).toHaveLength(activityBefore);
    expect(s.h.streamEvents).toHaveLength(eventsBefore);
  });

  it("still serves the transcript, and replays a send that was saved before the close", async () => {
    const s = await setup();
    const first = await send(s, { idempotencyKey: "before-close" });
    await closeRoom(s);
    expect((await transcript(s)).body.messages).toHaveLength(1);
    const replay = await send(s, { idempotencyKey: "before-close" });
    expect(replay.status).toBe(200);
    expect(replay.body.message.id).toBe(first.body.message.id);
    expectError(await send(s, { idempotencyKey: "after-close" }), 409, "room_closed");
  });
});

describe("activity, live updates and Room freshness", () => {
  it("writes a Message posted entry and one room.changed event per new note", async () => {
    const s = await setup();
    const eventsBefore = s.h.streamEvents.length;
    const activityBefore = s.h.activity.length;
    const response = await send(s, { body: "note one", mentions: [s.company.agents[0]!.id] });

    const entries = s.h.activity.slice(activityBefore);
    expect(entries.map((e) => e.message)).toEqual(["Message posted"]);
    expect(entries[0]).toMatchObject({ entityType: "boardroom_room", entityId: s.room.id });
    expect(entries[0]!.metadata).toMatchObject({
      actingUserId: s.operator.userId,
      roomId: s.room.id,
      messageId: response.body.message.id,
      mentionedAgentIds: [s.company.agents[0]!.id],
      ignoredMentionCount: 0,
    });
    // The body is not copied into the activity log.
    expect(JSON.stringify(entries[0]!.metadata)).not.toContain("note one");
    expect(s.h.streamEvents.slice(eventsBefore)).toEqual([
      { channel: "boardroom", companyId: s.company.id, event: { type: "room.changed", roomId: s.room.id, companyId: s.company.id } },
    ]);
  });

  it("does not fail the send when the activity write fails", async () => {
    const s = await setup();
    s.h.ctx.activity.log = async () => {
      throw new Error("activity down");
    };
    const response = await send(s, { body: "still saved" });
    expect(response.status).toBe(201);
    expect(await messageRows(s)).toHaveLength(1);
  });

  it("bumps the Room's updated_at and moves it up the list", async () => {
    const s = await setup();
    const second = await s.h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: s.company.id, title: "Newer", topic: "t", agentIds: [s.company.agents[0]!.id] },
      actor: s.owner,
    });
    const list = async () =>
      (await s.h.request<RoomListResponse>("GET", "/rooms", { query: { companyId: s.company.id }, actor: s.viewer })).body.rooms;
    expect((await list()).map((r) => r.title)).toEqual(["Newer", "Raise prices?"]);

    // Make the update visible even on a fast machine.
    await s.h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET updated_at = now() - interval '1 hour'");
    const before = (await s.h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms WHERE id = $1", [s.room.id]))[0]!.updated_at;
    await send(s, { body: "ping" });
    const after = (await s.h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms WHERE id = $1", [s.room.id]))[0]!.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    const untouched = (await s.h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms WHERE id = $1", [second.body.room.id]))[0]!.updated_at;
    expect(new Date(untouched).getTime()).toBeLessThan(new Date(after).getTime());
    expect((await list()).map((r) => r.title)).toEqual(["Raise prices?", "Newer"]);
  });
});

describe("hand-typed mentions", () => {
  it("are matched by exact name against active Participants (reported in the activity metadata)", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const response = await send(s, { body: "Hey @CTO, then @CEO." });
    expect(response.status).toBe(201);
    expect(response.body.ignoredMentions).toEqual([]);
    const entry = s.h.activity.find((e) => e.message === "Message posted")!;
    // Body order, not Participant order.
    expect(entry.metadata?.mentionedAgentIds).toEqual([cto!.id, ceo!.id]);
  });

  it("puts listed mentions first, then hand-typed ones, without duplicates", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    await send(s, { body: "@CEO @CTO again @CEO", mentions: [cto!.id] });
    const entry = s.h.activity.find((e) => e.message === "Message posted")!;
    expect(entry.metadata?.mentionedAgentIds).toEqual([cto!.id, ceo!.id]);
  });

  it("keeps a listed mention when the agent has been renamed since the body was written", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    await send(s, { body: "@OldName what now?", mentions: [ceo.id] });
    const entry = s.h.activity.find((e) => e.message === "Message posted")!;
    expect(entry.metadata?.mentionedAgentIds).toEqual([ceo.id]);
  });

  it("do not match an agent that is not an active Participant, and are not reported", async () => {
    const s = await setup({ agents: ["CEO", "CTO", "CFO"] });
    const response = await send(s, { body: "@CFO please look" });
    expect(response.body.ignoredMentions).toEqual([]);
    const entry = s.h.activity.find((e) => e.message === "Message posted")!;
    expect(entry.metadata?.mentionedAgentIds).toEqual([]);
  });
});

describe("findHandTypedMentions", () => {
  const people = [
    { agentId: "a", name: "Ada" },
    { agentId: "b", name: "Ada Lovelace" },
    { agentId: "c", name: "Bob" },
  ];

  it("prefers the longest name and does not double-count its prefix", () => {
    expect(findHandTypedMentions("@Ada Lovelace and @Ada", people)).toEqual(["b", "a"]);
  });

  it("needs a word boundary on both sides", () => {
    expect(findHandTypedMentions("mail me at x@Bob.com or @Bobby or @Bob!", people)).toEqual(["c"]);
    expect(findHandTypedMentions("@Adam", people)).toEqual([]);
  });

  it("is exact (case-sensitive) and ignores empty or ambiguous names", () => {
    expect(findHandTypedMentions("@bob", people)).toEqual([]);
    const twins = [
      { agentId: "x", name: "Sam" },
      { agentId: "y", name: "Sam" },
      { agentId: "z", name: null },
      { agentId: "w", name: "  " },
    ];
    expect(findHandTypedMentions("@Sam @ @", twins)).toEqual([]);
  });

  it("escapes regular expression characters in names", () => {
    expect(findHandTypedMentions("ask @R2.D2 (and @R2xD2)", [{ agentId: "r", name: "R2.D2" }])).toEqual(["r"]);
    expect(findHandTypedMentions("@(Dev)", [{ agentId: "d", name: "(Dev)" }])).toEqual(["d"]);
  });
});

describe("GET /rooms/:roomId/messages", () => {
  /** Messages one second apart, so the order is the insertion order (the same millisecond would tie, and ties sort by id). */
  async function seedMessages(s: Setup, count: number) {
    const rows = await s.h.sql<{ id: string }>(
      `INSERT INTO plugin_boardroom_79f8e138fc.room_messages (id, company_id, room_id, author_kind, author_id, body, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'user', $3, 'message ' || g, '2026-10-01T09:00:00Z'::timestamptz + g * interval '1 second'
       FROM generate_series(1, $4::int) g RETURNING id`,
      [s.company.id, s.room.id, s.operator.userId, count],
    );
    const ordered = await s.h.sql<{ id: string }>(
      "SELECT id FROM plugin_boardroom_79f8e138fc.room_messages WHERE room_id = $1 ORDER BY created_at, id",
      [s.room.id],
    );
    expect(ordered).toHaveLength(rows.length);
    return ordered.map((r) => r.id);
  }

  it("returns the latest 50 oldest first by default, and hasMore", async () => {
    const s = await setup();
    await seedMessages(s, 120);
    const page = await transcript(s);
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(50);
    expect(page.body.messages[0]!.body).toBe("message 71");
    expect(page.body.messages.at(-1)!.body).toBe("message 120");
    expect(page.body.hasMore).toBe(true);
  });

  it("pages older Messages with before, in a stable order with no duplicates", async () => {
    const s = await setup();
    const ids = await seedMessages(s, 120);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await transcript(s, { limit: "50", ...(cursor ? { before: cursor } : {}) });
      expect(page.status).toBe(200);
      seen.unshift(...page.body.messages.map((m) => m.id));
      pages += 1;
      if (!page.body.hasMore) break;
      cursor = page.body.messages[0]!.id;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(120);
  });

  it("orders Messages that share a timestamp by id, the same way on every page", async () => {
    const s = await setup();
    await s.h.sql(
      `INSERT INTO plugin_boardroom_79f8e138fc.room_messages (id, company_id, room_id, author_kind, author_id, body, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'user', 'u', 'same ' || g, '2026-10-01T09:00:00Z' FROM generate_series(1, 7) g`,
      [s.company.id, s.room.id],
    );
    const all = (await transcript(s, { limit: "200" })).body.messages.map((m) => m.id);
    expect(all).toHaveLength(7);
    expect([...all].sort()).toEqual(all);
    const newest = (await transcript(s, { limit: "3" })).body;
    const middle = (await transcript(s, { limit: "3", before: newest.messages[0]!.id })).body;
    const oldest = (await transcript(s, { limit: "3", before: middle.messages[0]!.id })).body;
    expect([...oldest.messages, ...middle.messages, ...newest.messages].map((m) => m.id)).toEqual(all);
    expect([newest.hasMore, middle.hasMore, oldest.hasMore]).toEqual([true, true, false]);
  });

  it("pages newer Messages with after (live catch-up)", async () => {
    const s = await setup();
    const ids = await seedMessages(s, 10);
    const page = await transcript(s, { after: ids[6]!, limit: "2" });
    expect(page.body.messages.map((m) => m.id)).toEqual([ids[7], ids[8]]);
    expect(page.body.hasMore).toBe(true);
    const rest = await transcript(s, { after: ids[8]! });
    expect(rest.body.messages.map((m) => m.id)).toEqual([ids[9]]);
    expect(rest.body.hasMore).toBe(false);
    expect((await transcript(s, { after: ids[9]! })).body).toEqual({ messages: [], hasMore: false });
  });

  it("answers 400 for a bad limit, a bad or foreign cursor, or both cursors", async () => {
    const s = await setup();
    const [first] = await seedMessages(s, 2);
    const secondRoom = await s.h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: s.company.id, title: "Two", topic: "t", agentIds: [s.company.agents[0]!.id] },
      actor: s.owner,
    });
    const foreign = await insertMessage(s.h.ctx.db, s.company.id, {
      roomId: secondRoom.body.room.id,
      authorKind: "user",
      authorId: s.owner.userId,
      body: "elsewhere",
    });
    for (const limit of ["0", "201", "-1", "abc", "1.5"]) expectError(await transcript(s, { limit }), 400, "invalid_request");
    expectError(await transcript(s, { before: "nope" }), 400, "invalid_request");
    expectError(await transcript(s, { before: randomUUID() }), 400, "invalid_request");
    expectError(await transcript(s, { after: foreign!.id }), 400, "invalid_request");
    expectError(await transcript(s, { before: first!, after: first! }), 400, "invalid_request");
    expect((await transcript(s, { limit: "200" })).status).toBe(200);
    expect((await transcript(s, { limit: "1" })).body.messages).toHaveLength(1);
  });

  it("returns an empty transcript for a new Room", async () => {
    const s = await setup();
    expect((await transcript(s)).body).toEqual({ messages: [], hasMore: false });
  });

  it("shows agent Messages with the agent's name, Round, Turn and run ids, and keeps them after the agent is removed", async () => {
    const s = await setup();
    const [ceo, cto] = s.company.agents;
    const trigger = await insertMessage(s.h.ctx.db, s.company.id, {
      roomId: s.room.id,
      authorKind: "user",
      authorId: s.operator.userId,
      body: "@CEO",
    });
    const round = await insertRound(s.h.ctx.db, s.company.id, {
      roomId: s.room.id,
      seq: 1,
      startedByUserId: s.operator.userId,
      triggerMessageId: trigger!.id,
      askAll: false,
      addressedAgentIds: [ceo!.id],
    });
    const turn = await insertTurn(s.h.ctx.db, s.company.id, { roundId: round!.id, agentId: ceo!.id, ord: 1 });
    const run = randomUUID();
    await insertMessage(s.h.ctx.db, s.company.id, {
      roomId: s.room.id,
      authorKind: "agent",
      authorId: ceo!.id,
      body: "Raise by 5 percent.",
      roundId: round!.id,
      turnId: turn!.id,
      runId: run,
    });

    const expected = {
      authorKind: "agent",
      authorId: ceo!.id,
      authorName: "CEO",
      body: "Raise by 5 percent.",
      roundId: round!.id,
      turnId: turn!.id,
      runId: run,
    };
    let messages = (await transcript(s)).body.messages;
    expect(messages.map((m) => m.authorKind)).toEqual(["user", "agent"]);
    expect(messages[1]).toMatchObject(expected);

    await removeParticipant(s.h.ctx.db, s.company.id, s.room.id, ceo!.id);
    messages = (await transcript(s)).body.messages;
    expect(messages[1]).toMatchObject(expected);
    expect(cto).toBeDefined();
  });

  it("keeps the Message when an agent name cannot be looked up, with a null name", async () => {
    const s = await setup();
    const ceo = s.company.agents[0]!;
    const trigger = await insertMessage(s.h.ctx.db, s.company.id, { roomId: s.room.id, authorKind: "user", authorId: s.operator.userId, body: "x" });
    const round = await insertRound(s.h.ctx.db, s.company.id, {
      roomId: s.room.id, seq: 1, startedByUserId: s.operator.userId, triggerMessageId: trigger!.id, askAll: false, addressedAgentIds: [ceo.id],
    });
    const turn = await insertTurn(s.h.ctx.db, s.company.id, { roundId: round!.id, agentId: ceo.id, ord: 1 });
    await insertMessage(s.h.ctx.db, s.company.id, {
      roomId: s.room.id, authorKind: "agent", authorId: ceo.id, body: "reply", roundId: round!.id, turnId: turn!.id,
    });
    s.h.ctx.agents.get = async () => {
      throw new Error("lookup down");
    };
    const messages = (await transcript(s)).body.messages;
    expect(messages[1]).toMatchObject({ authorKind: "agent", authorId: ceo.id, authorName: null, body: "reply" });
  });
});

/** Call the worker as the host would after its own checks, to reach the plugin's own role rules. */
async function callWorker(s: Setup, routeKey: string, userId: string, input: { body?: unknown }) {
  const spec = ROUTE_SPECS.find((r) => r.routeKey === routeKey)!;
  const request: PluginApiRequestInput = {
    routeKey,
    method: spec.method,
    path: spec.path,
    params: { roomId: s.room.id },
    query: { companyId: s.company.id },
    body: input.body ?? null,
    actor: { actorType: "user", actorId: userId, userId, agentId: null, runId: null },
    companyId: s.company.id,
    headers: {},
  };
  return (await s.h.plugin.definition.onApiRequest!(JSON.parse(JSON.stringify(request)))) as { status: number; body: unknown };
}

