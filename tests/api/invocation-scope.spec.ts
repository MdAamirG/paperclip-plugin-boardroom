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
import { table } from "../../src/db/sql.js";
import { REPLY_LINK_WAIT_MS, SETTLEMENT_WAIT_MS, handleRunEvent } from "../../src/engine/recovery.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";
import { runInInvocation } from "../support/host/invocation.js";

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
    await expect(call()).rejects.toThrow(/company context is required/);
    s.h.setOtherInvocationActive(true);
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

  it("does not finish a posted Turn whose reply is not linked yet, and finishes it once it is", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    const messageId = (await turnsOf(s, roundId))[0]!.messageId!;
    // The gap between settling the Turn and linking its Message, as a finisher with no settlement of its own
    // in flight sees it (another worker process saving the reply).
    await setMessageLink(s, first!.id, null);
    const delivered = runFinished(s, first!.runId!, first!.agentId);
    await settled();
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "queued"]);
    expect(activityMessages(s)).not.toContain("Turn posted");

    // The run event handler waits (bounded) for the link, then finishes the Turn inside its invocation.
    await setMessageLink(s, first!.id, messageId);
    await delivered;
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "running"]);
    expect(s.h.activity.find((entry) => entry.message === "Turn posted")?.metadata).toMatchObject({ messageId });
  });

  it("does not fail queued Turns from the sweep when the host says company context is required", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    await s.h.sdk.runJob(ROUND_SWEEP_JOB_KEY);
    const turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.status)).toEqual(["finished", "queued"]);
    expect(turns[0]).toMatchObject({ hostPending: true });
    expect(s.h.sessionSends).toHaveLength(1);
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

/**
 * Hold the first `ctx.db` call whose SQL matches `pattern` until `release()`. `reached` resolves when that
 * call arrives. Models the host round trips a settlement makes, so another signal can arrive in between.
 */
function holdDbCall(s: Setup, kind: "query" | "execute", pattern: RegExp) {
  const db = s.h.ctx.db;
  const original = db[kind].bind(db) as (sql: string, params?: unknown[]) => Promise<unknown>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let held = false;
  (db as unknown as Record<string, unknown>)[kind] = async (sql: string, params?: unknown[]) => {
    if (!held && pattern.test(sql)) {
      held = true;
      reach();
      await gate;
    }
    return original(sql, params);
  };
  return { reached, release };
}

/** The live settlement's `setTurnMessage`. */
const REPLY_LINK = /SET message_id = \$3/;

async function setMessageLink(s: Setup, turnId: string, messageId: string | null) {
  await s.h.ctx.db.execute(`UPDATE ${table(s.h.ctx.db, "turns")} SET message_id = $3::uuid WHERE company_id = $1 AND id = $2`, [
    s.company.id,
    turnId,
    messageId,
  ]);
}

describe("a run event that arrives while the live settlement is still saving the reply (F9)", () => {
  it("waits for the live settlement, then finishes the Turn and starts Turn 2 inside its invocation", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);

    // The host sends the live `done` first: the Turn is finished and host_pending, its Message is being linked.
    const link = holdDbCall(s, "execute", REPLY_LINK);
    live(s, first!, "Raise it by 5 percent.");
    await link.reached;
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ status: "finished", outcome: "posted", hostPending: true, messageId: null });

    // Then `agent.run.finished`, delivered inside an invocation for the company, while the reply is still saving.
    const delivered = runFinished(s, first!.runId!, first!.agentId);
    await settled();
    link.release();
    await delivered;

    const turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.status)).toEqual(["finished", "running"]);
    expect(turns[0]).toMatchObject({ outcome: "posted", hostPending: false });
    expect(turns[0]!.messageId).not.toBeNull();
    expect(s.h.sessionSends).toHaveLength(2);
    expect(s.h.activity.filter((entry) => entry.message === "Turn posted")).toHaveLength(1);
    expect(s.h.activity.find((entry) => entry.message === "Turn posted")?.metadata).toMatchObject({ messageId: turns[0]!.messageId });
  });

  it("completes a whole Round with no page open when every run event races its live settlement", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    for (const text of ["One.", "Two."]) {
      const turn = (await turnsOf(s, roundId)).find((t) => t.status === "running")!;
      const link = holdDbCall(s, "execute", REPLY_LINK);
      live(s, turn, text);
      await link.reached;
      const delivered = runFinished(s, turn.runId!, turn.agentId);
      await settled();
      link.release();
      await delivered;
    }
    expect((await getRound(s.h.ctx.db, s.company.id, roundId))!.status).toBe("completed");
    expect(activityMessages(s).filter((m) => m === "Turn posted")).toHaveLength(2);
    expect(activityMessages(s)).toContain("Round completed");
  });

  it("finishes the Turn when the live event wins the settle-once claim while the run event handler is settling", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);

    // The run event handler reads the Turn as running and goes to read the run; the live `done` lands meanwhile.
    const snapshot = holdDbCall(s, "query", /heartbeat_runs/);
    const delivered = runFinished(s, first!.runId!, first!.agentId);
    await snapshot.reached;
    const link = holdDbCall(s, "execute", REPLY_LINK);
    live(s, first!, "Raise it by 5 percent.");
    await link.reached;
    snapshot.release(); // The handler's own settle now loses the claim.
    await settled();
    link.release();
    await delivered;

    const turns = await turnsOf(s, roundId);
    expect(turns.map((t) => t.status)).toEqual(["finished", "running"]);
    expect(turns[0]).toMatchObject({ outcome: "posted", hostPending: false });
    expect(activityMessages(s).filter((m) => m === "Turn posted")).toHaveLength(1);
  });

  it("gives up after a bounded wait when the reply is never linked (the worker died saving it) and changes nothing", async () => {
    const s = await setup();
    const roundId = await askAll(s);
    const [first] = await turnsOf(s, roundId);
    live(s, first!, "One.");
    await settled();
    await setMessageLink(s, first!.id, null);

    const started = Date.now();
    await runInInvocation(s.company.id, () =>
      handleRunEvent(
        s.h.ctx,
        { eventId: randomUUID(), eventType: "agent.run.finished", companyId: s.company.id, occurredAt: new Date().toISOString(), entityId: first!.runId!, payload: { runId: first!.runId! } },
        { replyLinkWaitMs: 200 },
      ),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["finished", "queued"]);
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ hostPending: true });
    expect(activityMessages(s)).not.toContain("Turn posted");
  });

  it("keeps the run event handler's wait well inside the host's 15-minute event invocation", () => {
    expect(SETTLEMENT_WAIT_MS + REPLY_LINK_WAIT_MS).toBeLessThan(15 * 60 * 1000);
  });
});

describe("what a failed session start means (F2)", () => {
  async function failFirstWith(error: Error) {
    const s = await setup();
    s.h.failSends(() => true, () => error);
    const roundId = await askAll(s);
    return { s, roundId };
  }

  it.each([
    "company context is required",
    "the worker referenced a missing, expired, or unknown invocation scope",
    'requested company "c-2" but the current invocation is scoped to company "c-1"',
  ])("records a scope error as a failed Turn with the real text, not as the agent being not invokable: %s", async (reason) => {
    const message = `Plugin "x" is not allowed to perform "agents.sessions.create": ${reason}`;
    const { s, roundId } = await failFirstWith(new Error(message));
    const turns = await turnsOf(s, roundId);
    expect(turns[0]).toMatchObject({ status: "finished", outcome: "failed", skipReason: null, hostMessage: message });
  });

  it("recognises a scope error by the host's error code alone", async () => {
    const { s, roundId } = await failFirstWith(Object.assign(new Error("Agent is paused"), { code: -32005 }));
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "failed", skipReason: null });
  });

  it("records an unknown error as failed with its text", async () => {
    const { s, roundId } = await failFirstWith(new Error("socket hang up"));
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "failed", skipReason: null, hostMessage: "socket hang up" });
  });

  // The host's own wordings (agent-invokability.ts, budgets.ts, plugin-host-services.ts, heartbeat.ts).
  it.each([
    "Agent is not invokable in its current state",
    "Agent is not invokable because its reporting chain is invalid",
    "Agent no longer exists",
    "Agent not found",
    "Agent is paused because its budget hard-stop was reached.",
    "Company is paused and cannot start new work.",
    "Company is not active",
    "Agent wakeup was skipped by heartbeat policy",
  ])(
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
