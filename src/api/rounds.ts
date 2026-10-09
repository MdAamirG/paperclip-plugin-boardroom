import { listRounds } from "../db/index.js";
import { finishPendingHostWork } from "../engine/rounds.js";
import { requireLevel } from "./access.js";
import type { RouteHandler } from "./context.js";
import { ok } from "./errors.js";
import { toRoundViews } from "./round-view.js";
import { loadRoom } from "./rooms.js";
import type { RoundListResponse } from "./types.js";

/** `GET /rooms/:roomId/rounds`: the Room's Rounds, newest first, each with its Turns in order. */
export const listRoomRounds: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const room = await loadRoom(ctx, input.companyId, input.params.roomId);
  // This request is an invocation for the company, which a live session event is not: finish any host work
  // (next Turn, activity entry) a settlement left pending. A no-op when nothing is pending.
  await finishPendingHostWork(ctx, input.companyId);
  const rounds = (await listRounds(ctx.db, input.companyId, room.id)).reverse();
  return ok<RoundListResponse>({ rounds: await toRoundViews(ctx, input.companyId, room.id, rounds) });
};
