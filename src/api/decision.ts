import { getRoom, setRoomDecision } from "../db/index.js";
import { requireLevel } from "./access.js";
import { audit } from "./audit.js";
import type { RouteHandler } from "./context.js";
import { badRequest, ok, roomNotFound } from "./errors.js";
import { announceRoomChanged } from "./live.js";
import { buildRoomDetail, loadRoom } from "./rooms.js";
import { readBody } from "./validation.js";

/** Upper bound for the markdown (a limit of this plugin, not of the spec). */
export const DECISION_MAX = 50_000;
/** How much of the text goes into the activity entry. */
export const EXCERPT_MAX = 120;

/** The text on one line, cut to a short excerpt, for the activity entry (never the whole body). */
export function excerptOf(markdown: string): string {
  const flat = markdown.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

/**
 * `PATCH /rooms/:roomId/decision` (`control`): `{ companyId, decisionMd }`. Writes or replaces the
 * Decision record with the acting user and the time; an empty or blank string clears it. Allowed
 * in open and closed Rooms and during a Round. Answers with the Room detail.
 */
export const updateDecision: RouteHandler = async ({ ctx, input, actor }) => {
  const room = await loadRoom(ctx, input.companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const body = readBody(input);
  const raw = body.decisionMd;
  if (typeof raw !== "string") throw badRequest('"decisionMd" must be a string', { field: "decisionMd" });
  if (raw.length > DECISION_MAX) {
    throw badRequest(`"decisionMd" must be at most ${DECISION_MAX} characters`, { field: "decisionMd" });
  }
  const clearing = raw.trim() === "";

  const written = await setRoomDecision(ctx.db, room.companyId, room.id, clearing ? null : { markdown: raw, byUserId: actor.userId });
  if (!written) throw roomNotFound();

  await audit(ctx, {
    companyId: room.companyId,
    actingUserId: actor.userId,
    roomId: room.id,
    message: clearing ? "Decision cleared" : "Decision recorded",
    metadata: clearing
      ? { hadDecision: room.decisionMd !== null }
      : { excerpt: excerptOf(raw), length: raw.length, replaced: room.decisionMd !== null },
  });
  announceRoomChanged(ctx, room.companyId, room.id);

  const fresh = await getRoom(ctx.db, room.companyId, room.id);
  if (!fresh) throw roomNotFound();
  return ok(await buildRoomDetail(ctx, actor, fresh));
};
