import { listRounds } from "../db/index.js";
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
  const rounds = (await listRounds(ctx.db, input.companyId, room.id)).reverse();
  return ok<RoundListResponse>({ rounds: await toRoundViews(ctx, input.companyId, room.id, rounds) });
};
