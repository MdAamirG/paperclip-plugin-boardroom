import type { PluginContext } from "@paperclipai/plugin-sdk";
import { countCountedTurns, listActiveParticipants, listTurnCosts, type TurnCostRow } from "../db/index.js";
import { requireLevel } from "./access.js";
import type { RouteHandler } from "./context.js";
import { ok } from "./errors.js";
import { loadRoom } from "./rooms.js";
import type { AgentCost, OutcomeCounts, RoomCostsResponse } from "./types.js";
import { isUuid } from "./validation.js";

interface Tally {
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  events: number;
  subscriptionEvents: number;
  runCount: number;
}

const emptyTally = (): Tally => ({ costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, events: 0, subscriptionEvents: 0, runCount: 0 });

function add(tally: Tally, row: TurnCostRow): void {
  tally.costCents += row.costCents;
  tally.inputTokens += row.inputTokens;
  tally.cachedInputTokens += row.cachedInputTokens;
  tally.outputTokens += row.outputTokens;
  tally.events += row.events;
  tally.subscriptionEvents += row.subscriptionEvents;
  if (row.events > 0) tally.runCount += 1;
}

/** Every event is subscription billed with zero cents (and there is at least one event). */
const subscriptionBilled = (tally: Tally): boolean => tally.events > 0 && tally.subscriptionEvents === tally.events;

async function agentName(ctx: PluginContext, companyId: string, agentId: string): Promise<string | null> {
  if (!isUuid(agentId)) return null;
  try {
    return (await ctx.agents.get(agentId, companyId))?.name ?? null;
  } catch (error) {
    ctx.logger.warn("Boardroom could not look up an agent name", { agentId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * `GET /rooms/:roomId/costs` (`read`): lifetime cost, tokens and run count of the Room, the split
 * per agent (every agent that ever had a Turn, with an `isActiveParticipant` flag), and the Turns
 * used against the cap. Cost events are matched to the Room through the run ids stored on its Turns.
 */
export const getRoomCosts: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const room = await loadRoom(ctx, input.companyId, input.params.roomId);
  const [rows, participants, turnsUsed] = await Promise.all([
    listTurnCosts(ctx.db, input.companyId, room.id),
    listActiveParticipants(ctx.db, input.companyId, room.id),
    countCountedTurns(ctx.db, input.companyId, room.id),
  ]);

  const total = emptyTally();
  const byAgent = new Map<string, { tally: Tally; outcomes: OutcomeCounts }>();
  for (const row of rows) {
    add(total, row);
    let entry = byAgent.get(row.agentId);
    if (!entry) {
      entry = { tally: emptyTally(), outcomes: { posted: 0, silent: 0, failed: 0, skipped: 0 } };
      byAgent.set(row.agentId, entry);
    }
    add(entry.tally, row);
    if (row.outcome === "posted" || row.outcome === "silent" || row.outcome === "failed" || row.outcome === "skipped") {
      entry.outcomes[row.outcome] += 1;
    }
  }

  const active = new Set(participants.map((p) => p.agentId));
  const agents: AgentCost[] = await Promise.all(
    [...byAgent.entries()].map(async ([agentId, { tally, outcomes }]) => ({
      agentId,
      agentName: await agentName(ctx, input.companyId, agentId),
      isActiveParticipant: active.has(agentId),
      costCents: tally.costCents,
      inputTokens: tally.inputTokens,
      cachedInputTokens: tally.cachedInputTokens,
      outputTokens: tally.outputTokens,
      runCount: tally.runCount,
      outcomes,
      subscriptionBilled: subscriptionBilled(tally),
    })),
  );
  // Costliest first; ties by tokens, then name, so the order is stable.
  agents.sort(
    (a, b) =>
      b.costCents - a.costCents ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      (a.agentName ?? a.agentId).localeCompare(b.agentName ?? b.agentId),
  );

  return ok<RoomCostsResponse>({
    roomId: room.id,
    costCents: total.costCents,
    inputTokens: total.inputTokens,
    cachedInputTokens: total.cachedInputTokens,
    outputTokens: total.outputTokens,
    runCount: total.runCount,
    subscriptionBilled: subscriptionBilled(total),
    turnsUsed,
    maxTotalTurns: room.maxTotalTurns,
    agents,
  });
};
