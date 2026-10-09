/**
 * The host's invocation-scope rule (manual check finding F1). The host refuses a worker call that
 * names a company when it is made outside a host invocation (a live session event callback, a job
 * handler) and the company has no plugin configuration row. Boardroom has no settings, so a company
 * has no row: nothing may depend on such a call working. These tests run on a harness that models the
 * rule (`createBoardroomHarness()` without `everyCompanyConfigured`).
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomDetail, RoundListResponse, SendMessageResponse } from "../../src/api/types.js";
import { ROUND_SWEEP_JOB_KEY } from "../../src/constants.js";
import { getRound, listTurns } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup() {
  harness = await createBoardroomHarness();
  const h = harness;
  const company = await h.seedCompany({ agents: ["CEO", "CTO"] });
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title: "Raise prices?", topic: "Should we?", agentIds: company.agents.map((a) => a.id) },
    actor: owner,
  });
  expect(created.status).toBe(201);
  return { h, company, room: created.body.room, owner };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function askAll(s: Setup) {
  const response = await s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "Everyone, thoughts?", askAll: true },
    actor: s.owner,
  });
  expect(response.status).toBe(201);
  return response.body.round!.id;
}

const turnsOf = (s: Setup, roundId: string) => listTurns(s.h.ctx.db, s.company.id, roundId);
const live = (s: Setup, turn: { sessionId: string | null; runId: string | null }, message: string) =>
  s.h.simulateSessionEvent(turn.sessionId!, { runId: turn.runId!, seq: 1, eventType: "done", stream: "system", message, payload: null });
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
const activityMessages = (s: Setup) => s.h.activity.map((entry) => entry.message);
const runFinished = (s: Setup, runId: string, agentId: string) =>
  s.h.sdk.emit("agent.run.finished", { runId, agentId, status: "succeeded" }, { companyId: s.company.id, entityId: runId });

describe("the host's invocation-scope rule in the harness", () => {
  it("refuses a company-scoped call outside an invocation, admits it inside one and for a company with a config row", async () => {
    const s = await setup();
    const call = () => s.h.ctx.agents.list({ companyId: s.company.id, limit: 1 });
    await expect(call()).rejects.toThrow(/missing, expired, or unknown invocation scope/);
    s.h.saveCompanyConfig(s.company.id);
    await expect(call()).resolves.toBeDefined();
  });

  it("admits the plugin's own API request and a run event handler, and refuses a session event callback", async () => {
    const s = await setup();
    const roundId = await askAll(s); // An API request: sessions.create and send worked.
    const [first] = await turnsOf(s, roundId);
    expect(first).toMatchObject({ status: "running" });
    live(s, first!, "Raise it by 5 percent.");
    await settled();
    // The callback's host calls were refused (no activity entry, no session close, no stream event for it),
    // but the Turn is settled in the database with its reply.
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ status: "finished", outcome: "posted", hostPending: true });
  });
});

describe("a Round in a company without a plugin configuration row (F1)", () => {
  it("settles the reply from the live event, then continues with Turn 2 on the run event", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "Raise it by 5 percent.");
    await settled();

    // Live callback: the reply is saved, nothing needing the host happened, Turn 2 did not start.
    let turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.status)).toEqual(["finished", "queued"]);
    expect(turns[0]!.messageId).not.toBeNull();
    expect(s.h.sessionSends).toHaveLength(1);

    // The host's run event is delivered inside an invocation for the company: the Round continues.
    await runFinished(s, first!.runId!, first!.agentId);
    turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.status)).toEqual(["finished", "running"]);
    expect(turns[1]!.hostMessage).toBeNull();
    expect(s.h.sessionSends).toHaveLength(2);
    expect(activityMessages(s)).toContain("Turn posted");

    // Turn 2 finishes the same way and the Round completes, with its activity entry written.
    live(s, turns[1]!, "Agreed.");
    await settled();
    await runFinished(s, turns[1]!.runId!, turns[1]!.agentId);
    expect((await getRound(s.h.ctx.db, s.company.id, roundId))!.status).toBe("completed");
    expect(activityMessages(s).filter((m) => m === "Turn posted")).toHaveLength(2);
    expect(activityMessages(s)).toContain("Round completed");
  });

  it("finishes the pending host work once, even when the run event arrives twice", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    await runFinished(s, first!.runId!, first!.agentId);
    await runFinished(s, first!.runId!, first!.agentId);
    expect(s.h.sessionSends).toHaveLength(2);
    expect(activityMessages(s).filter((m) => m === "Turn posted")).toHaveLength(1);
  });

  it("continues on the page's own poll when no run event comes", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "queued"]);

    // GET /rooms/:id/rounds is an API request, an invocation for the company.
    const rounds = await s.h.request<RoundListResponse>("GET", `/rooms/${s.room.id}/rounds`, { query: { companyId: s.company.id }, actor: s.owner });
    expect(rounds.status).toBe(200);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "running"]);
  });

  it("does not throw or advance in the sweep (a job is outside any invocation), and does not lose the work", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    await s.h.sdk.runJob(ROUND_SWEEP_JOB_KEY);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "queued"]);
    await runFinished(s, first!.runId!, first!.agentId);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "running"]);
  });

  it("does the work in the live callback as before when the company does have a config row", async () => {
    const s = await setup();
    s.h.saveCompanyConfig(s.company.id);
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "running"]);
  });
});

describe("what a failed session start means (F2)", () => {
  async function failFirstWith(error: Error) {
    const s = await setup();
    s.h.failSends(() => true, () => error);
    const roundId = await askAll(s);
    return { s, roundId };
  }

  it("records a scope error as a failed Turn with the real text, not as the agent being not invokable", async () => {
    const message = 'Plugin x is not allowed to perform "agents.sessions.create": the worker referenced a missing, expired, or unknown invocation scope';
    const { s, roundId } = await failFirstWith(new Error(message));
    const turns = await turnsOf(s, roundId);
    expect(turns[0]).toMatchObject({ status: "finished", outcome: "failed", skipReason: null, hostMessage: message });
  });

  it("records an unknown error as failed with its text", async () => {
    const { s, roundId } = await failFirstWith(new Error("socket hang up"));
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "failed", skipReason: null, hostMessage: "socket hang up" });
  });

  it.each(["Agent is not invokable in its current state", "Agent is paused", "Agent is over budget (limit $5.00)", "Agent no longer exists"])(
    "still skips a genuine refusal of the agent: %s",
    async (message) => {
      const { s, roundId } = await failFirstWith(new Error(message));
      expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "skipped", skipReason: "not_invokable", hostMessage: message });
    },
  );

  it("moves on to the next Turn after a failed start and completes the Round", async () => {
    const s = await setup();
    s.h.failNextSend(new Error("socket hang up"));
    const roundId = await askAll(s);
    const turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.outcome ?? t.status)).toEqual(["failed", "running"]);
  });
});
