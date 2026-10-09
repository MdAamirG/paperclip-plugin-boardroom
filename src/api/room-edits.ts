import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  MAX_ACTIVE_PARTICIPANTS,
  MAX_MAX_TOTAL_TURNS,
  MIN_MAX_TOTAL_TURNS,
  closeRoomRow,
  countActiveParticipants,
  countCountedTurns,
  getActiveRound,
  getRoom,
  insertParticipant,
  removeParticipant,
  updateRoomSettings,
  type Room,
  type RoomSettingsPatch,
} from "../db/index.js";
import { requireLevel } from "./access.js";
import { audit } from "./audit.js";
import type { RouteHandler } from "./context.js";
import { badRequest, conflict, ok, roomNotFound, unprocessable, ApiError } from "./errors.js";
import { announceRoomChanged } from "./live.js";
import { touchRoomSafely } from "./room-touch.js";
import { TOPIC_MAX, TITLE_MAX, buildRoomDetail, loadRoom } from "./rooms.js";
import { isUuid, readBody, requiredString } from "./validation.js";

/** The Room must be open and between Rounds: 409 `room_closed` first, then 409 `round_active`. */
async function requireIdleOpenRoom(ctx: PluginContext, room: Room): Promise<void> {
  if (room.status === "closed") throw conflict("room_closed", "This Room is closed, so it can no longer be changed");
  if (await getActiveRound(ctx.db, room.companyId, room.id)) {
    throw conflict("round_active", "A Round is in progress. Stop it or wait for it to finish first.");
  }
}

/** A guarded write matched nothing: read the Room again to name the reason. */
async function refusalFor(ctx: PluginContext, room: Room): Promise<ApiError> {
  const current = await getRoom(ctx.db, room.companyId, room.id);
  if (!current) return roomNotFound();
  try {
    await requireIdleOpenRoom(ctx, current);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  return conflict("round_active", "The Room changed while this request ran. Try again.");
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `POST /rooms/:roomId/participants`: add an agent at the end of the join order. */
export const addParticipant: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const raw = readBody(input).agentId;
  if (typeof raw !== "string" || raw.trim() === "") throw badRequest('"agentId" must be an agent id', { field: "agentId" });
  const agentId = raw.trim().toLowerCase();
  await requireIdleOpenRoom(ctx, room);

  const agent = isUuid(agentId) ? await ctx.agents.get(agentId, companyId) : null;
  if (!agent || agent.companyId !== companyId) {
    throw unprocessable("agent_not_in_company", "That agent does not belong to this company", { agentId });
  }
  const active = await countActiveParticipants(ctx.db, companyId, room.id);
  if (active >= MAX_ACTIVE_PARTICIPANTS) {
    throw unprocessable("too_many_participants", `A Room has at most ${MAX_ACTIVE_PARTICIPANTS} Participants`, {
      limit: MAX_ACTIVE_PARTICIPANTS,
      active,
    });
  }

  const input2 = { roomId: room.id, agentId, addedByUserId: actor.userId };
  let added;
  try {
    added = await insertParticipant(ctx.db, companyId, input2);
  } catch (error) {
    // A concurrent add took the same position (unique `(room_id, position)`); one retry takes the next.
    ctx.logger.warn("Boardroom Participant add collided; retrying once", { roomId: room.id, error: errorMessage(error) });
    added = await insertParticipant(ctx.db, companyId, input2);
  }
  if (!added) throw conflict("already_participant", "That agent is already a Participant in this Room");

  await touchRoomSafely(ctx, companyId, room.id);
  await audit(ctx, {
    companyId,
    actingUserId: actor.userId,
    roomId: room.id,
    message: "Participant added",
    metadata: { agentId, agentName: agent.name, position: added.position },
  });
  announceRoomChanged(ctx, companyId, room.id);
  const fresh = (await getRoom(ctx.db, companyId, room.id)) ?? room;
  return ok(await buildRoomDetail(ctx, actor, fresh), 201);
};

/** `DELETE /rooms/:roomId/participants/:agentId`: soft-remove; earlier Messages keep the agent as author. */
export const removeParticipantRoute: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const agentId = (input.params.agentId ?? "").toLowerCase();
  await requireIdleOpenRoom(ctx, room);
  if (!isUuid(agentId) || !(await removeParticipant(ctx.db, companyId, room.id, agentId))) {
    throw new ApiError(404, "participant_not_found", "That agent is not an active Participant of this Room");
  }
  await touchRoomSafely(ctx, companyId, room.id);
  await audit(ctx, { companyId, actingUserId: actor.userId, roomId: room.id, message: "Participant removed", metadata: { agentId } });
  announceRoomChanged(ctx, companyId, room.id);
  const fresh = (await getRoom(ctx.db, companyId, room.id)) ?? room;
  return ok(await buildRoomDetail(ctx, actor, fresh));
};

function parseSettings(body: Record<string, unknown>): RoomSettingsPatch {
  const patch: RoomSettingsPatch = {};
  if (body.title !== undefined) patch.title = requiredString(body, "title", TITLE_MAX);
  if (body.topic !== undefined) patch.topic = requiredString(body, "topic", TOPIC_MAX);
  if (body.maxTotalTurns !== undefined) {
    const cap = body.maxTotalTurns;
    if (typeof cap !== "number") throw badRequest('"maxTotalTurns" must be a number', { field: "maxTotalTurns" });
    if (!Number.isInteger(cap) || cap < MIN_MAX_TOTAL_TURNS || cap > MAX_MAX_TOTAL_TURNS) {
      throw unprocessable("turn_cap_out_of_range", `The turn cap must be a whole number from ${MIN_MAX_TOTAL_TURNS} to ${MAX_MAX_TOTAL_TURNS}`, {
        min: MIN_MAX_TOTAL_TURNS,
        max: MAX_MAX_TOTAL_TURNS,
      });
    }
    patch.maxTotalTurns = cap;
  }
  if (Object.keys(patch).length === 0) throw badRequest('Send at least one of "title", "topic" or "maxTotalTurns"');
  return patch;
}

/** `PATCH /rooms/:roomId`: title, topic and turn cap. Fields that already hold the value are not changes. */
export const updateRoom: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  const patch = parseSettings(readBody(input));
  await requireIdleOpenRoom(ctx, room);

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  const effective: RoomSettingsPatch = {};
  for (const key of ["title", "topic", "maxTotalTurns"] as const) {
    if (patch[key] !== undefined && patch[key] !== room[key]) {
      changes[key] = { old: room[key], new: patch[key] };
      (effective as Record<string, unknown>)[key] = patch[key];
    }
  }
  if (Object.keys(changes).length === 0) return ok(await buildRoomDetail(ctx, actor, room));

  const metadata: Record<string, unknown> = { changes };
  if (changes.maxTotalTurns) {
    // Raising the cap after it was reached is the interesting case; the entry says it was reached.
    metadata.capWasReached = (await countCountedTurns(ctx.db, companyId, room.id)) >= room.maxTotalTurns;
  }
  if (!(await updateRoomSettings(ctx.db, companyId, room.id, effective))) throw await refusalFor(ctx, room);
  await audit(ctx, { companyId, actingUserId: actor.userId, roomId: room.id, message: "Room updated", metadata });
  announceRoomChanged(ctx, companyId, room.id);
  const fresh = (await getRoom(ctx.db, companyId, room.id)) ?? room;
  return ok(await buildRoomDetail(ctx, actor, fresh));
};

/** `POST /rooms/:roomId/close`: the record stays as it is; stop a Round first. */
export const closeRoom: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "control", room);
  await requireIdleOpenRoom(ctx, room);
  if (!(await closeRoomRow(ctx.db, companyId, room.id))) throw await refusalFor(ctx, room);
  await audit(ctx, { companyId, actingUserId: actor.userId, roomId: room.id, message: "Room closed", metadata: {} });
  announceRoomChanged(ctx, companyId, room.id);
  const fresh = (await getRoom(ctx.db, companyId, room.id)) ?? room;
  return ok(await buildRoomDetail(ctx, actor, fresh));
};
