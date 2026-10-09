import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listTurnCosts, listTurnsForRoom, type Round, type Turn, type TurnCostRow } from "../db/index.js";
import type { RoundView, TurnCost, TurnView } from "./types.js";
import { isUuid } from "./validation.js";

/** Agent names for the Turns (one lookup per agent); a failed lookup or a deleted agent gives null. */
async function agentNames(ctx: PluginContext, companyId: string, agentIds: readonly string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  await Promise.all(
    [...new Set(agentIds)].map(async (agentId) => {
      if (!isUuid(agentId)) return names.set(agentId, null);
      try {
        names.set(agentId, (await ctx.agents.get(agentId, companyId))?.name ?? null);
      } catch (error) {
        ctx.logger.warn("Boardroom could not look up an agent name", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        names.set(agentId, null);
      }
    }),
  );
  return names;
}

const NO_COST: TurnCost = { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, events: 0, subscriptionBilled: false };

function toTurnCost(row: TurnCostRow | undefined): TurnCost {
  if (!row) return NO_COST;
  return {
    costCents: row.costCents,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    events: row.events,
    subscriptionBilled: row.events > 0 && row.subscriptionEvents === row.events,
  };
}

function toTurnView(turn: Turn, name: string | null, cost: TurnCostRow | undefined): TurnView {
  return {
    id: turn.id,
    roundId: turn.roundId,
    agentId: turn.agentId,
    agentName: name,
    ord: turn.ord,
    status: turn.status,
    outcome: turn.outcome,
    skipReason: turn.skipReason,
    hostMessage: turn.hostMessage,
    runId: turn.runId,
    messageId: turn.messageId,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
    cost: toTurnCost(cost),
  };
}

/**
 * The Rounds with their Turns, in the order given. Loads every Turn of the Room (and its cost) in one query each,
 * then keeps those of the given Rounds. Pass only Rounds of `roomId`.
 */
export async function toRoundViews(
  ctx: PluginContext,
  companyId: string,
  roomId: string,
  rounds: readonly Round[],
): Promise<RoundView[]> {
  if (rounds.length === 0) return [];
  const wanted = new Set(rounds.map((r) => r.id));
  const [allTurns, costRows] = await Promise.all([listTurnsForRoom(ctx.db, companyId, roomId), listTurnCosts(ctx.db, companyId, roomId)]);
  const costs = new Map(costRows.map((row) => [row.turnId, row]));
  const turns = allTurns.filter((t) => wanted.has(t.roundId));
  const names = await agentNames(ctx, companyId, turns.map((t) => t.agentId));
  return rounds.map((round) => ({
    ...round,
    turns: turns.filter((t) => t.roundId === round.id).map((t) => toTurnView(t, names.get(t.agentId) ?? null, costs.get(t.id))),
  }));
}
