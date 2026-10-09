/**
 * Pause, Resume and Stop (ticket 09), with the session-cancel feature detection. Driven through the
 * plugin API routes, the live session events, the run events and the sweep job.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { RoomDetail, RoundControlResponse, SendMessageResponse, StopRoundResponse } from "../../src/api/types.js";
import { ROUND_SWEEP_JOB_KEY } from "../../src/constants.js";
import { getRoom, getRound, listTurns } from "../../src/db/index.js";
import { STOP_CANCEL_REASON } from "../../src/engine/round-controls.js";
import { isMethodNotFound } from "../../src/host-features.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: { maxTotalTurns?: number } = {}) {
  harness = await createBoardroomHarness();
  const h = harness;
  const company = await h.seedCompany({ agents: ["CEO", "CTO", "CFO"] });
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: {
      companyId: company.id,
      title: "Raise prices?",
      topic: "Should we?",
      agentIds: company.agents.map((a) => a.id),
      ...(options.maxTotalTurns ? { maxTotalTurns: options.maxTotalTurns } : {}),
    },
    actor: owner,
  });
  expect(created.status).toBe(201);
  const creates: string[] = [];
  const sessions = h.ctx.agents.sessions;
  const create = sessions.create.bind(sessions);
  sessions.create = async (agentId, companyId, opts) => {
    creates.push(agentId);
    return create(agentId, companyId, opts);
  };
  return { h, company, room: created.body.room, owner, admin: company.members.admin, operator: company.members.operator, viewer: company.members.viewer, creates };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function startRound(s: Setup, count = 3) {
  const agents = s.company.agents.slice(0, count);
  const response = await s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "thoughts?", mentions: agents.map((a) => a.id) },
    actor: s.owner,
  });
  expect(response.status).toBe(201);
  return response.body.round!.id;
}

const control = (s: Setup, verb: "pause" | "resume" | "stop", roundId: string, actor = s.owner, roomId = s.room.id) =>
  s.h.request<RoundControlResponse & StopRoundResponse & ApiErrorBody>("POST", `/rooms/${roomId}/rounds/${roundId}/${verb}`, {
    body: { companyId: s.company.id },
    actor,
  });
const turnsOf = (s: Setup, roundId: string) => listTurns(s.h.ctx.db, s.company.id, roundId);
const statusOf = async (s: Setup, roundId: string) => (await getRound(s.h.ctx.db, s.company.id, roundId))!.status;
const sweep = (s: Setup) => s.h.sdk.runJob(ROUND_SWEEP_JOB_KEY);

/** Finish the Turn behind send `index` with a live `done` event and wait until it is settled. */
async function reply(s: Setup, roundId: string, index: number, message: string | null = "My view") {
  const record = s.h.sessionSends[index]!;
  s.h.simulateSessionEvent(record.sessionId, { runId: record.runId!, seq: 1, eventType: "done", stream: null, message, payload: null });
  await vi.waitFor(async () => {
    expect((await turnsOf(s, roundId)).find((t) => t.runId === record.runId)?.status).toBe("finished");
  });
}

/** Let any pending worker work (a stray dispatch) show itself. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("Pause and Resume", () => {
  it("lets Turn 1 settle, starts nothing (even after a sweep), and Resume starts Turn 2", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    const paused = await control(s, "pause", roundId);
    expect(paused.status).toBe(200);
    expect(paused.body.round).toMatchObject({ id: roundId, status: "paused" });

    await reply(s, roundId, 0);
    await settleTicks();
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "queued", "queued"]);
    expect(s.creates).toHaveLength(1);
    await sweep(s);
    expect(s.creates).toHaveLength(1);
    expect(await statusOf(s, roundId)).toBe("paused");

    const resumed = await control(s, "resume", roundId);
    expect(resumed.status).toBe(200);
    expect(resumed.body.round).toMatchObject({ status: "running" });
    expect(s.creates).toHaveLength(2);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "running", "queued"]);
  });

  it("completes a paused Round on Resume when the last Turn settled meanwhile", async () => {
    const s = await setup();
    const roundId = await startRound(s, 1);
    await control(s, "pause", roundId);
    await reply(s, roundId, 0);
    expect(await statusOf(s, roundId)).toBe("paused");
    await control(s, "resume", roundId);
    expect(await statusOf(s, roundId)).toBe("completed");
  });

  it("answers 409 round_not_running from any other status", async () => {
    const s = await setup();
    const roundId = await startRound(s, 1);
    const resumeRunning = await control(s, "resume", roundId);
    expect(resumeRunning.status).toBe(409);
    expect(resumeRunning.body.error).toBe("round_not_running");
    await control(s, "pause", roundId);
    expect((await control(s, "pause", roundId)).status).toBe(409);
    await reply(s, roundId, 0);
    await control(s, "resume", roundId);
    expect(await statusOf(s, roundId)).toBe("completed");
    for (const verb of ["pause", "resume", "stop"] as const) {
      const response = await control(s, verb, roundId);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe("round_not_running");
    }
  });

  it("writes Round paused and Round resumed entries with the acting user and announces each change", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    const before = s.h.activity.length;
    s.h.streamEvents.length = 0;
    await control(s, "pause", roundId, s.admin);
    await control(s, "resume", roundId, s.admin);
    const entries = s.h.activity.slice(before).filter((e) => e.message === "Round paused" || e.message === "Round resumed");
    expect(entries.map((e) => e.message)).toEqual(["Round paused", "Round resumed"]);
    expect(entries[0]!.metadata).toMatchObject({ actingUserId: s.admin.userId, roomId: s.room.id, roundId });
    expect(s.h.streamEvents.filter((e) => (e.event as { roomId?: string }).roomId === s.room.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe("Stop", () => {
  it("skips queued Turns as stopped and hands Turn 1's run id to the page on the published SDK", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    const response = await control(s, "stop", roundId);
    expect(response.status).toBe(200);
    expect(response.body.cancel).toBe("fallback");
    expect(response.body.fallbackRunId).toBe(s.h.sessionSends[0]!.runId);
    expect(response.body.round).toMatchObject({ status: "stopped" });
    expect(response.body.round.endedAt).not.toBeNull();
    expect(response.body.round.turns.map((t) => [t.status, t.outcome, t.skipReason])).toEqual([
      ["running", null, null],
      ["finished", "skipped", "stopped"],
      ["finished", "skipped", "stopped"],
    ]);
  });

  it("never creates another session after Turn 1 settles, through the live event, a run event or the sweep", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    await control(s, "stop", roundId);
    await reply(s, roundId, 0);
    await settleTicks();
    expect(s.creates).toHaveLength(1);
    expect(await statusOf(s, roundId)).toBe("stopped");
    // A run event and the sweep after the fact change nothing either.
    const run = s.h.sessionSends[0]!;
    s.h.sdk.emit("agent.run.finished", { runId: run.runId, agentId: run.agentId, status: "succeeded" }, { companyId: s.company.id, entityId: run.runId! });
    await sweep(s);
    await settleTicks();
    expect(s.creates).toHaveLength(1);
    expect(s.h.sessionSends).toHaveLength(1);
    expect(await statusOf(s, roundId)).toBe("stopped");
  });

  it("settles the running Turn through the run event alone and still dispatches nothing", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    await control(s, "stop", roundId);
    const run = s.h.sessionSends[0]!;
    s.h.sdk.emit("agent.run.cancelled", { runId: run.runId, agentId: run.agentId, status: "cancelled", error: "Cancelled by the board" }, { companyId: s.company.id, entityId: run.runId! });
    await vi.waitFor(async () => expect((await turnsOf(s, roundId))[0]!.status).toBe("finished"));
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "failed", hostMessage: "Cancelled by the board" });
    await settleTicks();
    expect(s.creates).toHaveLength(1);
    expect(await statusOf(s, roundId)).toBe("stopped");
  });

  it("uses the host cancel when it exists and passes the session id, company id and reason", async () => {
    const s = await setup();
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    (s.h.ctx.agents.sessions as unknown as { cancelRun: unknown }).cancelRun = cancelRun;
    const roundId = await startRound(s);
    const response = await control(s, "stop", roundId);
    expect(response.body.cancel).toBe("host");
    expect(response.body.fallbackRunId).toBeUndefined();
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledWith(s.h.sessionSends[0]!.sessionId, s.company.id, { reason: STOP_CANCEL_REASON });
    expect(STOP_CANCEL_REASON).toBe("Boardroom: Round stopped");
  });

  it("falls back on method not found, and remembers it for the worker's lifetime", async () => {
    const s = await setup();
    const cancelRun = vi.fn().mockRejectedValue(Object.assign(new Error("Method not found"), { code: -32601 }));
    (s.h.ctx.agents.sessions as unknown as { cancelRun: unknown }).cancelRun = cancelRun;
    const first = await startRound(s);
    const response = await control(s, "stop", first);
    expect(response.body).toMatchObject({ cancel: "fallback", fallbackRunId: s.h.sessionSends[0]!.runId });
    await reply(s, first, 0);

    const second = await startRound(s, 1);
    const again = await control(s, "stop", second);
    expect(again.body.cancel).toBe("fallback");
    expect(cancelRun).toHaveBeenCalledTimes(1);
    const detections = s.h.logs.filter((l) => /cancel a session's run/.test(l.message));
    expect(detections).toHaveLength(1);
  });

  it("falls back on a not implemented error", async () => {
    const s = await setup();
    (s.h.ctx.agents.sessions as unknown as { cancelRun: unknown }).cancelRun = async () => {
      throw new Error("agents.sessions.cancelRun is not implemented");
    };
    const roundId = await startRound(s);
    expect((await control(s, "stop", roundId)).body.cancel).toBe("fallback");
  });

  it("reports failed on any other error, keeps the Round stopped and dispatches nothing", async () => {
    const s = await setup();
    (s.h.ctx.agents.sessions as unknown as { cancelRun: unknown }).cancelRun = async () => {
      throw new Error("The run store is unavailable");
    };
    const roundId = await startRound(s);
    const response = await control(s, "stop", roundId);
    expect(response.status).toBe(200);
    expect(response.body.cancel).toBe("failed");
    expect(response.body.fallbackRunId).toBeUndefined();
    expect(response.body.round.status).toBe("stopped");
    await reply(s, roundId, 0);
    await sweep(s);
    await settleTicks();
    expect(s.creates).toHaveLength(1);
    expect(await statusOf(s, roundId)).toBe("stopped");
  });

  it("answers none when no Turn is running (a paused Round whose Turn already settled)", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    await control(s, "pause", roundId);
    await reply(s, roundId, 0);
    const response = await control(s, "stop", roundId);
    expect(response.status).toBe(200);
    expect(response.body.cancel).toBe("none");
    expect(response.body.round.turns.map((t) => t.skipReason)).toEqual([null, "stopped", "stopped"]);
  });

  it("writes Round stopped with the cancel result and announces the change", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    const before = s.h.activity.length;
    s.h.streamEvents.length = 0;
    await control(s, "stop", roundId, s.admin);
    const entry = s.h.activity.slice(before).find((e) => e.message === "Round stopped")!;
    expect(entry.metadata).toMatchObject({ actingUserId: s.admin.userId, roundId, cancel: "fallback", skippedTurns: 2, fallbackRunId: s.h.sessionSends[0]!.runId });
    expect(s.h.streamEvents.some((e) => (e.event as { roomId?: string }).roomId === s.room.id)).toBe(true);
  });

  it("does not count Turns skipped by Stop toward the cap, leaves the Room open and lets a new Round start", async () => {
    const s = await setup({ maxTotalTurns: 4 });
    const roundId = await startRound(s); // 3 Turns; Stop skips 2, one counted (the running one)
    await control(s, "stop", roundId);
    await reply(s, roundId, 0);
    expect((await getRoom(s.h.ctx.db, s.company.id, s.room.id))!.status).toBe("open");

    const next = await s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
      body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "again", mentions: s.company.agents.map((a) => a.id) },
      actor: s.owner,
    });
    expect(next.status).toBe(201); // 1 counted + 3 requested = 4, exactly the cap
    expect(next.body.round).toMatchObject({ seq: 2, status: "running" });
  });

  it("lets the Room be closed once its Round is stopped", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    const refused = await s.h.request<ApiErrorBody>("POST", `/rooms/${s.room.id}/close`, { body: { companyId: s.company.id }, actor: s.owner });
    expect(refused.status).toBe(409);
    await control(s, "stop", roundId);
    const closed = await s.h.request<RoomDetail>("POST", `/rooms/${s.room.id}/close`, { body: { companyId: s.company.id }, actor: s.owner });
    expect(closed.status).toBe(200);
    expect(closed.body.room.status).toBe("closed");
  });
});

describe("access and shape", () => {
  it("refuses an operator and a viewer with 403 on all three routes", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    for (const actor of [s.operator, s.viewer]) {
      for (const verb of ["pause", "resume", "stop"] as const) {
        const response = await control(s, verb, roundId, actor);
        expect(response.status).toBe(403);
      }
    }
    expect(await statusOf(s, roundId)).toBe("running");
  });

  it("answers 404 for an unknown Round, a malformed id, and a Round of another Room", async () => {
    const s = await setup();
    const roundId = await startRound(s);
    expect((await control(s, "pause", randomUUID())).status).toBe(404);
    expect((await control(s, "stop", "not-a-uuid")).status).toBe(404);
    const other = await s.h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: s.company.id, title: "Other", topic: "t", agentIds: [s.company.agents[0]!.id] },
      actor: s.owner,
    });
    const wrong = await control(s, "pause", roundId, s.owner, other.body.room.id);
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toBe("round_not_found");
  });
});

describe("method-not-found detection", () => {
  it("recognizes JSON-RPC -32601 and the not implemented texts only", () => {
    expect(isMethodNotFound({ code: -32601, message: "x" })).toBe(true);
    expect(isMethodNotFound(new Error("Method not found: agents.sessions.cancelRun"))).toBe(true);
    expect(isMethodNotFound(new Error("not implemented"))).toBe(true);
    expect(isMethodNotFound(new Error("Run store unavailable"))).toBe(false);
    expect(isMethodNotFound(undefined)).toBe(false);
  });
});
