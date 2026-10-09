import { getRound, type Round } from "../db/index.js";
import { pauseRound, resumeRound, stopRound } from "../engine/round-controls.js";
import { requireLevel } from "./access.js";
import type { RouteHandler } from "./context.js";
import { ApiError, conflict, ok } from "./errors.js";
import { toRoundViews } from "./round-view.js";
import { loadRoom } from "./rooms.js";
import type { RoundControlResponse, StopRoundResponse } from "./types.js";
import { isUuid } from "./validation.js";

/** The Round named in the path, inside the Room named in the path and the caller's company. */
async function loadRound(ctx: Parameters<RouteHandler>[0]["ctx"], companyId: string, roomId: string, roundId: string | undefined): Promise<Round> {
  const round = isUuid(roundId) ? await getRound(ctx.db, companyId, roundId) : null;
  if (!round || round.roomId !== roomId) throw new ApiError(404, "round_not_found", "Round not found");
  return round;
}

async function view(ctx: Parameters<RouteHandler>[0]["ctx"], companyId: string, roomId: string, roundId: string) {
  const fresh = await getRound(ctx.db, companyId, roundId);
  if (!fresh) throw new ApiError(404, "round_not_found", "Round not found");
  const [round] = await toRoundViews(ctx, companyId, roomId, [fresh]);
  return round!;
}

const notRunning = (verb: string, status: string) =>
  conflict("round_not_running", `This Round cannot be ${verb}: it is ${status}`);

/** `POST /rooms/:roomId/rounds/:roundId/pause` (`control`): running to paused; any other status is 409 `round_not_running`. */
export const pauseRoundRoute: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const round = await loadRound(ctx, companyId, room.id, input.params.roundId);
  if (!(await pauseRound(ctx, round, actor.userId))) {
    throw notRunning("paused", (await getRound(ctx.db, companyId, round.id))?.status ?? round.status);
  }
  return ok<RoundControlResponse>({ round: await view(ctx, companyId, room.id, round.id) });
};

/** `POST .../resume` (`control`): paused to running, then advance. Any other status is 409 `round_not_running`. */
export const resumeRoundRoute: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const round = await loadRound(ctx, companyId, room.id, input.params.roundId);
  if (!(await resumeRound(ctx, round, actor.userId))) {
    throw notRunning("resumed", (await getRound(ctx.db, companyId, round.id))?.status ?? round.status);
  }
  return ok<RoundControlResponse>({ round: await view(ctx, companyId, room.id, round.id) });
};

/** `POST .../stop` (`control`): from running or paused. Answers with the Round and how the cancel went. */
export const stopRoundRoute: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const round = await loadRound(ctx, companyId, room.id, input.params.roundId);
  const outcome = await stopRound(ctx, round, actor.userId);
  if (!outcome) throw notRunning("stopped", (await getRound(ctx.db, companyId, round.id))?.status ?? round.status);
  return ok<StopRoundResponse>({ round: await view(ctx, companyId, room.id, round.id), ...outcome });
};
