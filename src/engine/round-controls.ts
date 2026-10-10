import type { PluginContext } from "@paperclipai/plugin-sdk";
import { audit } from "../api/audit.js";
import { announceRoomChanged } from "../api/live.js";
import { touchRoomSafely } from "../api/room-touch.js";
import type { StopCancelResult } from "../api/types.js";
import { getRunningTurn, setRoundStatus, skipQueuedTurnsAsStopped, type Round } from "../db/index.js";
import { STOP_CANCEL_REASON } from "../constants.js";
import { cancelSessionRun } from "../host-features.js";
import { advanceRound } from "./rounds.js";

export { STOP_CANCEL_REASON };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Pause: `running` to `paused`. The running Turn finishes normally; `advanceRound` starts nothing
 * while the Round is paused (the sweep only advances `running` Rounds). Returns false when the
 * Round was not `running` (compare-and-set).
 */
export async function pauseRound(ctx: PluginContext, round: Round, actingUserId: string): Promise<boolean> {
  if (!(await setRoundStatus(ctx.db, round.companyId, round.id, "paused", { expectedFrom: ["running"] }))) return false;
  await touchRoomSafely(ctx, round.companyId, round.roomId);
  await audit(ctx, {
    companyId: round.companyId,
    actingUserId,
    roomId: round.roomId,
    message: "Round paused",
    metadata: { roundId: round.id, seq: round.seq },
  });
  announceRoomChanged(ctx, round.companyId, round.roomId);
  return true;
}

/** Resume: `paused` to `running`, then advance (the next Turn starts, or the Round completes). False when the Round was not `paused`. */
export async function resumeRound(ctx: PluginContext, round: Round, actingUserId: string): Promise<boolean> {
  if (!(await setRoundStatus(ctx.db, round.companyId, round.id, "running", { expectedFrom: ["paused"] }))) return false;
  await touchRoomSafely(ctx, round.companyId, round.roomId);
  await audit(ctx, {
    companyId: round.companyId,
    actingUserId,
    roomId: round.roomId,
    message: "Round resumed",
    metadata: { roundId: round.id, seq: round.seq },
  });
  announceRoomChanged(ctx, round.companyId, round.roomId);
  await advanceRound(ctx, round.companyId, round.id);
  return true;
}

export interface StopOutcome {
  cancel: StopCancelResult;
  fallbackRunId?: string;
}

/**
 * Stop, from `running` or `paused`: the Round becomes `stopped` first (so nothing can dispatch
 * after this point), every queued Turn is skipped as `stopped`, then the running Turn's run is
 * cancelled through the host when it can. The running Turn still settles through `settleTurn` (a
 * cancelled run settles as failed); `advanceRound` then does nothing. A failed cancel leaves the
 * Round stopped. Returns null when the Round was neither running nor paused.
 */
export async function stopRound(ctx: PluginContext, round: Round, actingUserId: string): Promise<StopOutcome | null> {
  const { companyId } = round;
  if (!(await setRoundStatus(ctx.db, companyId, round.id, "stopped", { expectedFrom: ["running", "paused"] }))) return null;
  const skipped = await skipQueuedTurnsAsStopped(ctx.db, companyId, round.id);

  const outcome = await cancelRunningTurn(ctx, round);
  await touchRoomSafely(ctx, companyId, round.roomId);
  await audit(ctx, {
    companyId,
    actingUserId,
    roomId: round.roomId,
    message: "Round stopped",
    metadata: {
      roundId: round.id,
      seq: round.seq,
      cancel: outcome.cancel,
      skippedTurns: skipped,
      ...(outcome.fallbackRunId ? { fallbackRunId: outcome.fallbackRunId } : {}),
    },
  });
  announceRoomChanged(ctx, companyId, round.roomId);
  return outcome;
}

async function cancelRunningTurn(ctx: PluginContext, round: Round): Promise<StopOutcome> {
  let turn;
  try {
    turn = await getRunningTurn(ctx.db, round.companyId, round.id);
  } catch (error) {
    ctx.logger.warn("Boardroom could not read the running Turn to cancel it", { roundId: round.id, error: errorMessage(error) });
    return { cancel: "failed" };
  }
  // No running Turn, or one whose session was not created yet (it is still starting): nothing to cancel.
  if (!turn || !turn.sessionId) return { cancel: "none" };
  const result = await cancelSessionRun(ctx, turn.sessionId, round.companyId, STOP_CANCEL_REASON);
  if (result === "fallback") {
    // The page cancels by run id; a Turn that has no run id yet has nothing to hand over.
    return turn.runId ? { cancel: "fallback", fallbackRunId: turn.runId } : { cancel: "none" };
  }
  return { cancel: result };
}
