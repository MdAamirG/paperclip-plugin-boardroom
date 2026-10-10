/**
 * Completion recovery (ticket 08): platform run events, the run-table fallback and the one-minute
 * sweep. Every path settles a Turn through `settleTurn`, so a Turn settles once and its Message is
 * saved once.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@paperclipai/plugin-sdk";
import type { RoomDetail, SendMessageResponse } from "../../src/api/types.js";
import { ROUND_SWEEP_JOB_KEY } from "../../src/constants.js";
import { getRound, listRounds, listTurns } from "../../src/db/index.js";
import { POSTED_REPAIR_GRACE_SECONDS, STALE_DISPATCH_SECONDS } from "../../src/engine/recovery.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const SCHEMA = "plugin_boardroom_79f8e138fc";

async function setup() {
  harness = await createBoardroomHarness({ everyCompanyConfigured: true });
  const h = harness;
  const company = await h.seedCompany({ agents: ["CEO", "CTO", "CFO"] });
  const owner = company.members.owner;
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title: "Raise prices?", topic: "Should we?", agentIds: company.agents.map((a) => a.id) },
    actor: owner,
  });
  expect(created.status).toBe(201);
  return { h, company, room: created.body.room, owner };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Keep the live-event callbacks the worker passes to `sendMessage` (the fake drops them when a session closes). */
function captureLiveCallbacks(s: Setup) {
  const callbacks = new Map<string, (event: AgentSessionEvent) => void>();
  const sessions = s.h.ctx.agents.sessions;
  const send = sessions.sendMessage.bind(sessions);
  sessions.sendMessage = async (sessionId, companyId, opts) => {
    if (opts.onEvent) callbacks.set(sessionId, opts.onEvent);
    return send(sessionId, companyId, opts);
  };
  return callbacks;
}

async function startTwoAgentRound(s: Setup) {
  const [ceo, cto] = s.company.agents;
  const response = await s.h.request<SendMessageResponse>("POST", `/rooms/${s.room.id}/messages`, {
    body: { companyId: s.company.id, idempotencyKey: randomUUID(), body: "@CEO @CTO thoughts?", mentions: [ceo!.id, cto!.id] },
    actor: s.owner,
  });
  expect(response.status).toBe(201);
  return { roundId: response.body.round!.id, ceo: ceo!, cto: cto! };
}

const turnsOf = (s: Setup, roundId: string) => listTurns(s.h.ctx.db, s.company.id, roundId);
const agentMessages = (s: Setup) =>
  s.h.sql<{ id: string; author_id: string; body: string; turn_id: string; run_id: string }>(
    `SELECT * FROM ${SCHEMA}.room_messages WHERE author_kind = 'agent' ORDER BY created_at, id`,
  );
const runEvent = (s: Setup, type: "finished" | "failed" | "cancelled", runId: string, agentId: string, extra: Record<string, unknown> = {}, companyId = s.company.id) =>
  s.h.sdk.emit(`agent.run.${type}` as "agent.run.finished", { runId, agentId, status: type === "finished" ? "succeeded" : type, ...extra }, { companyId, entityId: runId });
/** The fake host inserts a queued run row on every send; move it to the state the test needs. */
async function seedRun(
  s: Setup,
  run: { id: string; companyId: string; agentId: string; status: string; resultJson?: Record<string, unknown> | null; error?: string },
) {
  await s.h.sql(
    "UPDATE public.heartbeat_runs SET status = $3, result_json = $4::jsonb, error = $5, finished_at = now() WHERE id = $1 AND company_id = $2",
    [run.id, run.companyId, run.status, run.resultJson ? JSON.stringify(run.resultJson) : null, run.error ?? null],
  );
}
const sweep = (s: Setup) => s.h.sdk.runJob(ROUND_SWEEP_JOB_KEY);

describe("the sweep job", () => {
  it("is declared in the manifest to run every minute", async () => {
    const s = await setup();
    expect(s.h.ctx.manifest.jobs).toMatchObject([{ jobKey: ROUND_SWEEP_JOB_KEY, schedule: "* * * * *" }]);
  });

  it("restart test: settles a running Turn from the run table, starts Turn 2, saves one Message", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    expect(first).toMatchObject({ status: "running", agentId: ceo.id });
    await s.h.restart(); // The live callback is gone.
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "Raise it by 5 percent." } });

    await sweep(s);
    const turns = await turnsOf(s, roundId);
    expect(turns[0]).toMatchObject({ status: "finished", outcome: "posted" });
    expect(turns[1]).toMatchObject({ status: "running", agentId: s.company.agents[1]!.id });
    const messages = await agentMessages(s);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "Raise it by 5 percent.", turn_id: first!.id, author_id: ceo.id, run_id: first!.runId });

    await sweep(s); // Idempotent: nothing more happens.
    expect(await agentMessages(s)).toHaveLength(1);
    expect((await turnsOf(s, roundId))[1]!.status).toBe("running");
  });

  it("settles a succeeded run with a blank summary as silent and a failed run as failed", async () => {
    const s = await setup();
    const { roundId, ceo, cto } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "  " } });
    await sweep(s);
    const second = (await turnsOf(s, roundId))[1]!;
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "silent", messageId: null });
    await seedRun(s, { id: second.runId!, companyId: s.company.id, agentId: cto.id, status: "timed_out", error: "Timed out after 10m" });
    await sweep(s);
    expect((await turnsOf(s, roundId))[1]).toMatchObject({ outcome: "failed", hostMessage: "Timed out after 10m" });
    expect(await agentMessages(s)).toHaveLength(0);
    expect((await getRound(s.h.ctx.db, s.company.id, roundId))!.status).toBe("completed");
  });

  it("leaves a run that is still running alone", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "running" });
    await sweep(s);
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["running", "queued"]);
  });

  it("leaves a Turn alone when its run is not in the run table, and ignores another company's run row", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    const other = await s.h.seedCompany({ name: "Other", issuePrefix: "OTH", agents: ["Spy"] });
    // The run row (with a reply) sits under another company: it must not be read for this company's Turn.
    await s.h.sql(`UPDATE public.heartbeat_runs SET company_id = $2, agent_id = $3, status = 'succeeded', result_json = '{"summary":"leak"}' WHERE id = $1`, [first!.runId, other.id, other.agents[0]!.id]);
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]!.status).toBe("running");
    expect(ceo).toBeDefined();
  });

  it("advances a running Round that has only queued Turns, and starts the Turn once across two sweeps", async () => {
    const s = await setup();
    const { roundId } = await startTwoAgentRound(s);
    // Simulate a crash: Turn 1 is done, Turn 2 never dispatched, nothing is running.
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET status = 'finished', outcome = 'silent', finished_at = now() WHERE ord = 1`);
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET status = 'queued', started_at = NULL, session_id = NULL, run_id = NULL WHERE ord = 2`);
    const before = s.h.sessionSends.length;
    await sweep(s);
    await sweep(s);
    expect(s.h.sessionSends.length).toBe(before + 1);
    expect((await turnsOf(s, roundId))[1]!.status).toBe("running");
  });

  it("completes a running Round with no running or queued Turn", async () => {
    const s = await setup();
    const { roundId } = await startTwoAgentRound(s);
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET status = 'finished', outcome = 'silent', finished_at = now()`);
    await sweep(s);
    expect((await getRound(s.h.ctx.db, s.company.id, roundId))!.status).toBe("completed");
    expect(s.h.activity.filter((e) => e.message === "Round completed")).toHaveLength(1);
    await sweep(s);
    expect(s.h.activity.filter((e) => e.message === "Round completed")).toHaveLength(1);
  });

  it("never advances a paused Round", async () => {
    const s = await setup();
    const { roundId } = await startTwoAgentRound(s);
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET status = 'finished', outcome = 'silent', finished_at = now() WHERE ord = 1`);
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET status = 'queued', started_at = NULL WHERE ord = 2`);
    await s.h.sql(`UPDATE ${SCHEMA}.rounds SET status = 'paused'`);
    const before = s.h.sessionSends.length;
    await sweep(s);
    expect(s.h.sessionSends.length).toBe(before);
    expect((await getRound(s.h.ctx.db, s.company.id, roundId))!.status).toBe("paused");
    expect((await turnsOf(s, roundId))[1]!.status).toBe("queued");
  });

  it("fails a running Turn that never got a run id after the dispatch timeout, not before", async () => {
    const s = await setup();
    const { roundId } = await startTwoAgentRound(s);
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET run_id = NULL WHERE ord = 1`);
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]!.status).toBe("running");
    await s.h.sql(`UPDATE ${SCHEMA}.turns SET started_at = now() - ($1::int + 5) * interval '1 second' WHERE ord = 1`, [STALE_DISPATCH_SECONDS]);
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ status: "finished", outcome: "failed" });
    expect((await turnsOf(s, roundId))[1]!.status).toBe("running");
  });

  it("only visits companies and keeps one company's problem from stopping another", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "ok" } });
    const other = await s.h.seedCompany({ name: "Other", issuePrefix: "OTH", agents: ["Solo"] });
    const otherRoom = await s.h.request<RoomDetail>("POST", "/rooms", {
      body: { companyId: other.id, title: "Other", topic: "t", agentIds: [other.agents[0]!.id] },
      actor: other.members.owner,
    });
    await s.h.request("POST", `/rooms/${otherRoom.body.room.id}/messages`, {
      body: { companyId: other.id, idempotencyKey: randomUUID(), body: "@Solo hi", mentions: [other.agents[0]!.id] },
      actor: other.members.owner,
    });
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]!.outcome).toBe("posted");
    const otherRounds = await listRounds(s.h.ctx.db, other.id, otherRoom.body.room.id);
    expect((await listTurns(s.h.ctx.db, other.id, otherRounds[0]!.id))[0]!.status).toBe("running");
  });
});

describe("posted Turns whose Message was lost", () => {
  async function orphan(s: Setup, ageSeconds: number, summary: string | null) {
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    // The worker settled the Turn as posted (`host_pending` set, as `finishRunningTurn` does), then died before saving the Message.
    await s.h.sql(
      `UPDATE ${SCHEMA}.turns SET status = 'finished', outcome = 'posted', host_pending = true, finished_at = now() - $1::int * interval '1 second' WHERE id = $2`,
      [ageSeconds, first!.id],
    );
    if (summary !== null) await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary } });
    return { roundId, first: first! };
  }

  it("saves the reply from the run summary once", async () => {
    const s = await setup();
    const { roundId, first } = await orphan(s, POSTED_REPAIR_GRACE_SECONDS + 10, "Recovered reply");
    await sweep(s);
    await sweep(s);
    const messages = await agentMessages(s);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "Recovered reply", turn_id: first.id });
    expect((await turnsOf(s, roundId))[0]!.messageId).toBe(messages[0]!.id);
  });

  it("links a Message that was saved but never linked, without a second one", async () => {
    const s = await setup();
    const { first } = await orphan(s, POSTED_REPAIR_GRACE_SECONDS + 10, "Recovered reply");
    await s.h.sql(
      `INSERT INTO ${SCHEMA}.room_messages (id, company_id, room_id, author_kind, author_id, body, round_id, turn_id, run_id)
       SELECT gen_random_uuid(), company_id, $2::uuid, 'agent', agent_id, 'Original', round_id, id, run_id FROM ${SCHEMA}.turns WHERE id = $1`,
      [first.id, s.room.id],
    );
    await sweep(s);
    expect(await agentMessages(s)).toHaveLength(1);
    expect((await turnsOf(s, first.roundId))[0]!.messageId).not.toBeNull();
  });

  it("marks the Turn failed when the reply cannot be recovered", async () => {
    const s = await setup();
    const { roundId } = await orphan(s, POSTED_REPAIR_GRACE_SECONDS + 10, null);
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "failed", hostMessage: "The reply could not be saved" });
    expect(await agentMessages(s)).toHaveLength(0);
  });

  it.each([
    ["posted", "Recovered reply"],
    ["failed", null],
  ] as const)("writes one Turn %s entry for a repaired Turn, and closes its session", async (outcome, summary) => {
    const s = await setup();
    const close = vi.spyOn(s.h.ctx.agents.sessions, "close");
    const { first } = await orphan(s, POSTED_REPAIR_GRACE_SECONDS + 10, summary);
    await sweep(s);
    await sweep(s);
    const entries = s.h.activity.filter((e) => /^Turn /.test(e.message) && (e.metadata as { turnId?: string }).turnId === first.id);
    expect(entries.map((e) => e.message)).toEqual([`Turn ${outcome}`]);
    expect(entries[0]!.metadata).toMatchObject({ outcome, runId: first.runId });
    expect(close).toHaveBeenCalledWith(first.sessionId, s.company.id);
    expect((await turnsOf(s, first.roundId))[0]!.hostPending).toBe(false);
  });

  it("leaves a recently posted Turn alone", async () => {
    const s = await setup();
    const { roundId } = await orphan(s, 1, "Too early");
    await sweep(s);
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "posted", messageId: null });
    expect(await agentMessages(s)).toHaveLength(0);
  });
});

describe("run events", () => {
  it("agent.run.finished settles the Turn from the run summary, then the live done event changes nothing", async () => {
    const s = await setup();
    const live = captureLiveCallbacks(s);
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "From the run table" } });
    await runEvent(s, "finished", first!.runId!, ceo.id);
    const turns = await turnsOf(s, roundId);
    expect(turns[0]).toMatchObject({ status: "finished", outcome: "posted" });
    expect(turns[1]!.status).toBe("running"); // advanced
    const sessionId = first!.sessionId!;
    live.get(sessionId)!({ sessionId, runId: first!.runId!, seq: 1, eventType: "done", stream: null, message: "A different live text", payload: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const messages = await agentMessages(s);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("From the run table");
    expect(s.h.activity.filter((e) => e.message === "Turn posted")).toHaveLength(1);
  });

  it("agent.run.finished with no summary settles as silent", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: null });
    await runEvent(s, "finished", first!.runId!, ceo.id);
    expect((await turnsOf(s, roundId))[0]).toMatchObject({ outcome: "silent", messageId: null });
  });

  it("a live done event first wins, and the run event after it changes nothing", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    s.h.simulateSessionEvent(first!.sessionId!, { runId: first!.runId!, seq: 1, eventType: "done", stream: null, message: "Live text", payload: null });
    await vi.waitFor(() => expect(s.h.activity.filter((e) => e.message === "Turn posted")).toHaveLength(1));
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "Other" } });
    await runEvent(s, "finished", first!.runId!, ceo.id);
    expect((await agentMessages(s)).map((m) => m.body)).toEqual(["Live text"]);
    expect(s.h.activity.filter((e) => e.message === "Turn posted")).toHaveLength(1);
  });

  it.each(["failed", "cancelled"] as const)("agent.run.%s settles the Turn as failed and the Round moves on", async (type) => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await runEvent(s, type, first!.runId!, ceo.id, { error: type === "failed" ? "Adapter crashed" : null });
    const turns = await turnsOf(s, roundId);
    expect(turns[0]).toMatchObject({ status: "finished", outcome: "failed", hostMessage: type === "failed" ? "Adapter crashed" : null });
    expect(turns[1]!.status).toBe("running");
    expect(await agentMessages(s)).toHaveLength(0);
  });

  it("closes the session of a settled Turn", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    const close = vi.spyOn(s.h.ctx.agents.sessions, "close");
    await runEvent(s, "failed", first!.runId!, ceo.id);
    expect(close).toHaveBeenCalledWith(first!.sessionId, s.company.id);
  });

  it("does nothing for a run id of another company or of no Turn", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    const other = await s.h.seedCompany({ name: "Other", issuePrefix: "OTH", agents: ["Spy"] });
    await runEvent(s, "failed", first!.runId!, ceo.id, {}, other.id); // Right run id, wrong company.
    await runEvent(s, "failed", randomUUID(), ceo.id); // Unknown run.
    await s.h.sdk.emit("agent.run.failed", { runId: "not-a-uuid" }, { companyId: s.company.id });
    await s.h.sdk.emit("agent.run.failed", {}, { companyId: s.company.id });
    expect((await turnsOf(s, roundId)).map((t) => t.status)).toEqual(["running", "queued"]);
    expect(await agentMessages(s)).toHaveLength(0);
  });

  it("recovers after a restart: the run event settles a Turn whose live callback is gone", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await s.h.restart();
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "After restart" } });
    await runEvent(s, "finished", first!.runId!, ceo.id);
    expect((await agentMessages(s)).map((m) => m.body)).toEqual(["After restart"]);
  });
});

describe("activity of recovered Turns", () => {
  it("writes one entry per settlement, whichever paths see the Turn", async () => {
    const s = await setup();
    const { roundId, ceo } = await startTwoAgentRound(s);
    const [first] = await turnsOf(s, roundId);
    await seedRun(s, { id: first!.runId!, companyId: s.company.id, agentId: ceo.id, status: "succeeded", resultJson: { summary: "Once" } });
    await Promise.all([runEvent(s, "finished", first!.runId!, ceo.id), sweep(s)]);
    await sweep(s);
    await runEvent(s, "finished", first!.runId!, ceo.id);
    const entries = s.h.activity.filter((e) => e.message === "Turn posted");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.metadata).toMatchObject({ turnId: first!.id, outcome: "posted", runId: first!.runId });
    expect(await agentMessages(s)).toHaveLength(1);
  });
});
