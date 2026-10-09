import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { ROUND_SWEEP_JOB_KEY } from "../constants.js";
import { audit } from "../api/audit.js";
import { announceRoomChanged } from "../api/live.js";
import { touchRoomSafely } from "../api/room-touch.js";
import { isUuid } from "../api/validation.js";
import {
  findTurnByRunId,
  getMessageIdForTurn,
  getRound,
  getRunSnapshot,
  insertMessage,
  isRunTerminal,
  listCompaniesWithUnsettledRows,
  listPostedTurnsWithoutMessage,
  listRunningTurns,
  markPostedTurnFailed,
  setTurnMessage,
  type RunSnapshot,
  type Turn,
} from "../db/index.js";
import { finishPendingHostWork, settleTurn, type TurnSettlement } from "./rounds.js";

/** A `running` Turn with no run id after this long never reached the host (the worker died mid-start): it is failed. */
export const STALE_DISPATCH_SECONDS = 300;
/** A `posted` Turn without its Message is repaired only after this long, so a live settlement is not raced. */
export const POSTED_REPAIR_GRACE_SECONDS = 120;

const RUN_EVENTS = ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a finished host run means for its Turn. `succeeded` is the reply (blank means silent); anything else failed. */
export function settlementForRun(run: Pick<RunSnapshot, "status" | "summary" | "error">, runId: string): TurnSettlement {
  if (run.status === "succeeded") {
    const text = run.summary ?? "";
    return text.trim() === "" ? { outcome: "silent", runId } : { outcome: "posted", text, runId };
  }
  return { outcome: "failed", runId, hostMessage: run.error ?? null };
}

/** Subscribe to the run events and register the sweep job. Called once from `setup`. */
export function registerRecovery(ctx: PluginContext): void {
  for (const eventType of RUN_EVENTS) {
    ctx.events.on(eventType, async (event) => {
      try {
        await handleRunEvent(ctx, event);
      } catch (error) {
        ctx.logger.error("Boardroom could not handle a run event", { eventType, error: errorMessage(error) });
      }
    });
  }
  ctx.jobs.register(ROUND_SWEEP_JOB_KEY, async () => {
    await runRoundSweep(ctx);
  });
}

/**
 * A platform run event: find the Turn by run id and company, then settle it. Keyed by run id only;
 * an unknown run or a run of another company changes nothing. The reply of a finished run is read
 * from `heartbeat_runs` (the live session event may have been lost).
 */
export async function handleRunEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const payload = (event.payload ?? {}) as { runId?: unknown; status?: unknown; error?: unknown };
  const runId = isUuid(payload.runId) ? payload.runId : isUuid(event.entityId) ? event.entityId : null;
  if (!runId || !event.companyId) return;
  const turn = await findTurnByRunId(ctx.db, event.companyId, runId);
  if (!turn) return;
  if (turn.status !== "running") {
    // Settled already (the live event wins). This handler runs inside an invocation for the company, which
    // the live event callback did not: finish the host part (activity entry, session close, next Turn).
    await finishPendingHostWork(ctx, event.companyId);
    return;
  }

  let settlement: TurnSettlement;
  if (event.eventType === "agent.run.finished") {
    const run = await getRunSnapshot(ctx.db, event.companyId, runId);
    settlement = settlementForRun({ status: "succeeded", summary: run?.summary ?? null, error: null }, runId);
  } else {
    const error = typeof payload.error === "string" && payload.error !== "" ? payload.error : null;
    settlement = { outcome: "failed", runId, hostMessage: error };
  }
  await settleTurn(ctx, event.companyId, turn.id, settlement);
  await finishPendingHostWork(ctx, event.companyId);
}

/**
 * The one-minute sweep. Per company with unsettled rows: settle `running` Turns whose run is over,
 * fail a Turn that never got a run, repair `posted` Turns with no Message, then advance every
 * `running` Round with nothing in flight (which also completes a Round with nothing left).
 * One company failing does not stop the others.
 */
export async function runRoundSweep(ctx: PluginContext): Promise<void> {
  const companyIds = await listCompaniesWithUnsettledRows(ctx.db);
  for (const companyId of companyIds) {
    try {
      await sweepCompany(ctx, companyId);
    } catch (error) {
      ctx.logger.error("Boardroom sweep failed for a company", { companyId, error: errorMessage(error) });
    }
  }
}

async function sweepCompany(ctx: PluginContext, companyId: string): Promise<void> {
  for (const turn of await listRunningTurns(ctx.db, companyId)) {
    try {
      await sweepRunningTurn(ctx, companyId, turn);
    } catch (error) {
      ctx.logger.error("Boardroom sweep could not settle a Turn", { turnId: turn.id, error: errorMessage(error) });
    }
  }
  for (const turn of await listPostedTurnsWithoutMessage(ctx.db, companyId, POSTED_REPAIR_GRACE_SECONDS)) {
    try {
      await repairPostedTurn(ctx, companyId, turn);
    } catch (error) {
      ctx.logger.error("Boardroom sweep could not repair a Turn", { turnId: turn.id, error: errorMessage(error) });
    }
  }
  // The host part of settled Turns, then every Round with nothing in flight. A job runs outside any
  // invocation, so for a company without a plugin configuration row this is skipped until a run event
  // or an API request (inside an invocation) does it.
  await finishPendingHostWork(ctx, companyId);
}

async function sweepRunningTurn(ctx: PluginContext, companyId: string, turn: Turn): Promise<void> {
  if (!turn.runId) {
    const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt > STALE_DISPATCH_SECONDS * 1000) {
      await settleTurn(ctx, companyId, turn.id, { outcome: "failed", hostMessage: "The agent's run never started" });
    }
    return;
  }
  const run = await getRunSnapshot(ctx.db, companyId, turn.runId);
  if (!run || !isRunTerminal(run.status)) return; // Still active (or not visible yet): leave it alone.
  await settleTurn(ctx, companyId, turn.id, settlementForRun(run, turn.runId));
}

/**
 * A Turn was marked `posted` but the worker died before the Message was linked. Link a Message
 * that exists; otherwise save the reply from the run summary; otherwise the Turn becomes `failed`.
 */
async function repairPostedTurn(ctx: PluginContext, companyId: string, turn: Turn): Promise<void> {
  const round = await getRound(ctx.db, companyId, turn.roundId);
  if (!round) return;
  let messageId = await getMessageIdForTurn(ctx.db, companyId, turn.id);
  if (!messageId) {
    const run = turn.runId ? await getRunSnapshot(ctx.db, companyId, turn.runId) : null;
    const text = run?.summary ?? "";
    if (text.trim() !== "") {
      const message = await insertMessage(ctx.db, companyId, {
        roomId: round.roomId,
        authorKind: "agent",
        authorId: turn.agentId,
        body: text,
        roundId: round.id,
        turnId: turn.id,
        runId: turn.runId,
      });
      messageId = message?.id ?? null;
    }
  }
  if (messageId) {
    await setTurnMessage(ctx.db, companyId, turn.id, messageId);
    await touchRoomSafely(ctx, companyId, round.roomId);
  } else {
    await markPostedTurnFailed(ctx.db, companyId, turn.id, "The reply could not be saved");
  }
  await audit(ctx, {
    companyId,
    actingUserId: null,
    roomId: round.roomId,
    message: messageId ? "Turn posted" : "Turn failed",
    metadata: { roundId: round.id, turnId: turn.id, agentId: turn.agentId, runId: turn.runId, outcome: messageId ? "posted" : "failed", messageId, repaired: true },
  });
  announceRoomChanged(ctx, companyId, round.roomId);
}
