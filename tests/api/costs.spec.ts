/**
 * Cost visibility (ticket 14): `GET /rooms/:roomId/costs` and the per-Turn cost on Round history,
 * read from the stub `public.cost_events` table through the run ids stored on the Room's Turns.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { RoomCostsResponse, RoomDetail, RoundListResponse } from "../../src/api/types.js";
import { insertMessage, insertRound, insertTurn, removeParticipant, setRoundStatus } from "../../src/db/index.js";
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
  const created = await h.request<RoomDetail>("POST", "/rooms", {
    body: {
      companyId: company.id,
      title: "Raise prices?",
      topic: "Should we?",
      agentIds: company.agents.map((a) => a.id),
      ...(options.maxTotalTurns ? { maxTotalTurns: options.maxTotalTurns } : {}),
    },
    actor: company.members.owner,
  });
  expect(created.status).toBe(201);
  return { h, company, room: created.body.room, owner: company.members.owner, viewer: company.members.viewer, operator: company.members.operator };
}

type Setup = Awaited<ReturnType<typeof setup>>;

interface TurnSpec {
  agentIndex: number;
  outcome: "posted" | "silent" | "failed" | "skipped" | null;
  /** Give the Turn a seeded `heartbeat_runs` row (true) or leave it without a run. */
  run?: boolean;
  skipReason?: "stopped" | "not_invokable";
}

/** A completed Round with the given Turns; returns each Turn with its run id (null when it had none). */
async function seedRound(s: Setup, seq: number, specs: TurnSpec[]) {
  const db = s.h.ctx.db;
  const trigger = await insertMessage(db, s.company.id, { roomId: s.room.id, authorKind: "user", authorId: s.owner.userId, body: `question ${seq}` });
  const round = await insertRound(db, s.company.id, {
    roomId: s.room.id,
    seq,
    startedByUserId: s.owner.userId,
    triggerMessageId: trigger!.id,
    askAll: true,
    addressedAgentIds: specs.map((spec) => s.company.agents[spec.agentIndex]!.id),
  });
  const turns: Array<{ id: string; runId: string | null; agentId: string }> = [];
  for (const [i, spec] of specs.entries()) {
    const agent = s.company.agents[spec.agentIndex]!;
    const turn = await insertTurn(db, s.company.id, { roundId: round!.id, agentId: agent.id, ord: i + 1 });
    let runId: string | null = null;
    if (spec.run !== false && spec.outcome !== "skipped") {
      runId = (await s.h.seedRun({ companyId: s.company.id, agentId: agent.id })).id;
    }
    if (spec.outcome) {
      await s.h.sql(
        `UPDATE plugin_boardroom_79f8e138fc.turns SET status = 'finished', outcome = $3, skip_reason = $4, run_id = $5, finished_at = now()
          WHERE company_id = $1 AND id = $2`,
        [s.company.id, turn!.id, spec.outcome, spec.skipReason ?? null, runId],
      );
    } else if (runId) {
      await s.h.sql(`UPDATE plugin_boardroom_79f8e138fc.turns SET status = 'running', run_id = $3 WHERE company_id = $1 AND id = $2`, [s.company.id, turn!.id, runId]);
    }
    turns.push({ id: turn!.id, runId, agentId: agent.id });
  }
  await setRoundStatus(db, s.company.id, round!.id, "completed");
  return { round: round!, turns };
}

const costs = (s: Setup, actor = s.viewer, roomId = s.room.id) =>
  s.h.request<RoomCostsResponse>("GET", `/rooms/${roomId}/costs`, { query: { companyId: s.company.id }, actor });
const rounds = (s: Setup) =>
  s.h.request<RoundListResponse>("GET", `/rooms/${s.room.id}/rounds`, { query: { companyId: s.company.id }, actor: s.viewer });

function cost(s: Setup, agentIndex: number, runId: string | null, costCents: number, extra: Record<string, unknown> = {}) {
  return s.h.seedCostEvent({ companyId: s.company.id, agentId: s.company.agents[agentIndex]!.id, runId, costCents, ...extra });
}

describe("GET /rooms/:roomId/costs", () => {
  it("sums cents, tokens and runs for two Turns of two agents and splits them per agent", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [
      { agentIndex: 0, outcome: "posted" },
      { agentIndex: 1, outcome: "silent" },
    ]);
    // The first Turn's run has two cost events; the second has one.
    await cost(s, 0, turns[0]!.runId, 100, { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 });
    await cost(s, 0, turns[0]!.runId, 50, { inputTokens: 500, outputTokens: 100 });
    await cost(s, 1, turns[1]!.runId, 30, { inputTokens: 40, cachedInputTokens: 5, outputTokens: 60 });

    const response = await costs(s);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      roomId: s.room.id,
      costCents: 180,
      inputTokens: 1540,
      cachedInputTokens: 205,
      outputTokens: 460,
      runCount: 2,
      subscriptionBilled: false,
      turnsUsed: 2,
      maxTotalTurns: 40,
    });
    expect(response.body.agents).toHaveLength(2);
    expect(response.body.agents[0]).toMatchObject({
      agentId: s.company.agents[0]!.id,
      agentName: "CEO",
      isActiveParticipant: true,
      costCents: 150,
      inputTokens: 1500,
      cachedInputTokens: 200,
      outputTokens: 400,
      runCount: 1,
      outcomes: { posted: 1, silent: 0, failed: 0, skipped: 0 },
    });
    expect(response.body.agents[1]).toMatchObject({
      agentName: "CTO",
      costCents: 30,
      runCount: 1,
      outcomes: { posted: 0, silent: 1, failed: 0, skipped: 0 },
    });
  });

  it("does not count a cost event of another company that carries the same run id", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [{ agentIndex: 0, outcome: "posted" }]);
    await cost(s, 0, turns[0]!.runId, 100, { inputTokens: 10 });
    const other = await s.h.seedCompany({ agents: ["Spy"] });
    await s.h.seedCostEvent({ companyId: other.id, agentId: other.agents[0]!.id, runId: turns[0]!.runId, costCents: 9999, inputTokens: 999 });

    const body = (await costs(s)).body;
    expect(body).toMatchObject({ costCents: 100, inputTokens: 10, runCount: 1 });
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ costCents: 100 });
    const history = (await rounds(s)).body.rounds[0]!.turns[0]!;
    expect(history.cost).toMatchObject({ costCents: 100, events: 1 });
  });

  it("does not count cost events of runs that are not Turns of this Room", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [{ agentIndex: 0, outcome: "posted" }]);
    await cost(s, 0, turns[0]!.runId, 10);
    const unrelated = await s.h.seedRun({ companyId: s.company.id, agentId: s.company.agents[0]!.id });
    await cost(s, 0, unrelated.id, 500);
    await cost(s, 0, null, 700);
    expect((await costs(s)).body).toMatchObject({ costCents: 10, runCount: 1 });
  });

  it("keeps a removed Participant in the breakdown with its spend and outcome counts", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [
      { agentIndex: 0, outcome: "posted" },
      { agentIndex: 1, outcome: "failed" },
    ]);
    await cost(s, 1, turns[1]!.runId, 25, { outputTokens: 7 });
    await removeParticipant(s.h.ctx.db, s.company.id, s.room.id, s.company.agents[1]!.id);

    const body = (await costs(s)).body;
    const cto = body.agents.find((a) => a.agentId === s.company.agents[1]!.id)!;
    expect(cto).toMatchObject({ isActiveParticipant: false, costCents: 25, outputTokens: 7, outcomes: { posted: 0, silent: 0, failed: 1, skipped: 0 } });
    expect(body.agents.find((a) => a.agentId === s.company.agents[0]!.id)).toMatchObject({ isActiveParticipant: true });
    expect(body.costCents).toBe(25);
  });

  it("counts a Turn skipped before its run started in the outcomes but not in turnsUsed", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [
      { agentIndex: 0, outcome: "posted" },
      { agentIndex: 1, outcome: "skipped", skipReason: "stopped" },
      { agentIndex: 2, outcome: "skipped", skipReason: "not_invokable" },
    ]);
    await cost(s, 0, turns[0]!.runId, 5);
    const body = (await costs(s)).body;
    expect(body.turnsUsed).toBe(1);
    expect(body.runCount).toBe(1);
    expect(body.agents.map((a) => [a.agentName, a.outcomes.skipped, a.runCount])).toEqual(
      expect.arrayContaining([
        ["CEO", 0, 1],
        ["CTO", 1, 0],
        ["CFO", 1, 0],
      ]),
    );
    expect(body.agents).toHaveLength(3);
  });

  it("reports Turns used and the cap across Rounds", async () => {
    const s = await setup({ maxTotalTurns: 5 });
    await seedRound(s, 1, [{ agentIndex: 0, outcome: "posted" }, { agentIndex: 1, outcome: "silent" }]);
    await seedRound(s, 2, [{ agentIndex: 0, outcome: "failed" }, { agentIndex: 2, outcome: "skipped", skipReason: "stopped" }]);
    expect((await costs(s)).body).toMatchObject({ turnsUsed: 3, maxTotalTurns: 5, costCents: 0, runCount: 0 });
  });

  it("flags subscription-billed events with zero cents so the UI shows tokens and $0 (subscription)", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [
      { agentIndex: 0, outcome: "posted" },
      { agentIndex: 1, outcome: "posted" },
      { agentIndex: 2, outcome: "posted" },
    ]);
    await cost(s, 0, turns[0]!.runId, 0, { billingType: "subscription_included", inputTokens: 900, outputTokens: 100 });
    // Overage with real cents is not a "$0" subscription figure.
    await cost(s, 1, turns[1]!.runId, 12, { billingType: "subscription_overage", inputTokens: 50 });
    // Mixed: one subscription event and one metered event.
    await cost(s, 2, turns[2]!.runId, 0, { billingType: "subscription_included" });
    await cost(s, 2, turns[2]!.runId, 3, { billingType: "metered_api" });

    const body = (await costs(s)).body;
    const byName = (name: string) => body.agents.find((a) => a.agentName === name)!;
    expect(byName("CEO")).toMatchObject({ costCents: 0, inputTokens: 900, outputTokens: 100, subscriptionBilled: true });
    expect(byName("CTO").subscriptionBilled).toBe(false);
    expect(byName("CFO").subscriptionBilled).toBe(false);
    expect(body.subscriptionBilled).toBe(false);

    const history = (await rounds(s)).body.rounds[0]!.turns;
    expect(history[0]!.cost).toMatchObject({ costCents: 0, inputTokens: 900, outputTokens: 100, subscriptionBilled: true });
  });

  it("flags the Room as subscription billed when every event is", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [{ agentIndex: 0, outcome: "posted" }]);
    await cost(s, 0, turns[0]!.runId, 0, { billingType: "subscription_included", inputTokens: 5 });
    expect((await costs(s)).body).toMatchObject({ subscriptionBilled: true, costCents: 0, inputTokens: 5 });
  });

  it("answers an empty Room with zeros", async () => {
    const s = await setup();
    expect((await costs(s)).body).toEqual({
      roomId: s.room.id,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runCount: 0,
      subscriptionBilled: false,
      turnsUsed: 0,
      maxTotalTurns: 40,
      agents: [],
    });
  });

  it("lets every company member read costs", async () => {
    const s = await setup();
    for (const actor of [s.viewer, s.operator, s.owner, s.company.members.admin]) {
      expect((await costs(s, actor)).status).toBe(200);
    }
  });

  it("answers 404 for an unknown Room, a malformed id, or a Room of another company", async () => {
    const s = await setup();
    for (const roomId of [randomUUID(), "not-a-uuid"]) {
      const response = await costs(s, s.viewer, roomId);
      expect(response.status).toBe(404);
      expect((response.body as unknown as ApiErrorBody).error).toBe("room_not_found");
    }
    const other = await s.h.seedCompany({ agents: ["Other"] });
    const foreign = await s.h.request<RoomCostsResponse>("GET", `/rooms/${s.room.id}/costs`, { query: { companyId: other.id }, actor: other.members.viewer });
    expect(foreign.status).toBe(404);
  });

  it("is one company-filtered SELECT over the Room's Turns joined to cost_events", async () => {
    const s = await setup();
    await seedRound(s, 1, [{ agentIndex: 0, outcome: "posted" }]);
    const statements: string[] = [];
    const query = s.h.ctx.db.query.bind(s.h.ctx.db);
    s.h.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return query(sql, params);
    }) as typeof s.h.ctx.db.query;
    await costs(s);
    const joined = statements.filter((sql) => sql.includes("public.cost_events"));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatch(/c\.company_id = t\.company_id/);
    expect(joined[0]).toMatch(/t\.company_id = \$1/);
  });
});

describe("Round history cost", () => {
  it("shows each Turn's own cost; a Turn with no cost events shows zero", async () => {
    const s = await setup();
    const { turns } = await seedRound(s, 1, [
      { agentIndex: 0, outcome: "posted" },
      { agentIndex: 1, outcome: "silent" },
      { agentIndex: 2, outcome: "skipped", skipReason: "stopped" },
    ]);
    await cost(s, 0, turns[0]!.runId, 100, { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 });
    await cost(s, 0, turns[0]!.runId, 20, { inputTokens: 1 });

    const history = (await rounds(s)).body.rounds[0]!.turns;
    expect(history[0]!.cost).toEqual({ costCents: 120, inputTokens: 1001, cachedInputTokens: 200, outputTokens: 300, events: 2, subscriptionBilled: false });
    const zero = { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, events: 0, subscriptionBilled: false };
    expect(history[1]!.cost).toEqual(zero);
    expect(history[2]!.cost).toEqual(zero);
    expect(history[2]).toMatchObject({ outcome: "skipped", skipReason: "stopped" });
  });

  it("carries the cost on the Turns of the Room detail's active Round too", async () => {
    const s = await setup();
    const trigger = await insertMessage(s.h.ctx.db, s.company.id, { roomId: s.room.id, authorKind: "user", authorId: s.owner.userId, body: "go" });
    const round = await insertRound(s.h.ctx.db, s.company.id, {
      roomId: s.room.id, seq: 1, startedByUserId: s.owner.userId, triggerMessageId: trigger!.id, askAll: false, addressedAgentIds: [s.company.agents[0]!.id],
    });
    const turn = await insertTurn(s.h.ctx.db, s.company.id, { roundId: round!.id, agentId: s.company.agents[0]!.id, ord: 1 });
    const run = await s.h.seedRun({ companyId: s.company.id, agentId: s.company.agents[0]!.id, status: "running" });
    await s.h.sql(`UPDATE plugin_boardroom_79f8e138fc.turns SET status = 'running', run_id = $2 WHERE id = $1`, [turn!.id, run.id]);
    await cost(s, 0, run.id, 8, { outputTokens: 4 });
    const detail = await s.h.request<RoomDetail>("GET", `/rooms/${s.room.id}`, { query: { companyId: s.company.id }, actor: s.viewer });
    expect(detail.body.activeRound!.turns[0]!.cost).toMatchObject({ costCents: 8, outputTokens: 4, events: 1 });
  });
});
