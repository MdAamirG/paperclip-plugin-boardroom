import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { resolveActor } from "./access.js";
import type { RouteHandler } from "./context.js";
import { ApiError, badRequest } from "./errors.js";
import { isUuid } from "./validation.js";
import { listRoomMessages, sendMessage } from "./messages.js";
import { updateDecision } from "./decision.js";
import { createRoom, getRoomDetail, listRooms } from "./rooms.js";
import { addParticipant, closeRoom, removeParticipantRoute, updateRoom } from "./room-edits.js";
import { listRoomRounds } from "./rounds.js";
import { ROUTE_SPECS, type RouteKey } from "./route-table.js";
import { listRoomsForIssue } from "./issue-rooms.js";
import { addWorkLink, createWork, removeWorkLink } from "./work.js";

/**
 * Route key to handler. A route with no entry answers 501 `not_implemented`; the ticket that owns
 * the route adds its handler here and nothing else (the route table already declares it).
 */
const HANDLERS: Partial<Record<RouteKey, RouteHandler>> = {
  "rooms.list": listRooms,
  "rooms.create": createRoom,
  "rooms.get": getRoomDetail,
  "rooms.update": updateRoom,
  "rooms.close": closeRoom,
  "participants.add": addParticipant,
  "participants.remove": removeParticipantRoute,
  "messages.list": listRoomMessages,
  "messages.send": sendMessage,
  "rounds.list": listRoomRounds,
  "decision.update": updateDecision,
  "work.create": createWork,
  "work-links.add": addWorkLink,
  "work-links.remove": removeWorkLink,
  "issues.rooms": listRoomsForIssue,
};

const KNOWN_ROUTE_KEYS: ReadonlySet<string> = new Set(ROUTE_SPECS.map((spec) => spec.routeKey));

/**
 * The worker's `onApiRequest`. Order: known route, a well-formed company id, then the actor and their role (agents and
 * non-members are refused on every route, built or not), then the handler. Every error becomes a
 * response with its own status, because a thrown error would reach the host as a 502.
 */
export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    if (!KNOWN_ROUTE_KEYS.has(input.routeKey)) {
      return new ApiError(404, "route_not_found", `Unknown Boardroom route: ${input.routeKey}`).toResponse();
    }
    // The host passes the company id to Postgres as a uuid; a malformed one would be a cast error.
    if (!isUuid(input.companyId)) return badRequest("companyId must be a company id").toResponse();
    const actor = await resolveActor(ctx, input);
    const handler = HANDLERS[input.routeKey as RouteKey];
    if (!handler) {
      return new ApiError(501, "not_implemented", `${input.routeKey} is not implemented yet`).toResponse();
    }
    return await handler({ ctx, input, actor });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    ctx.logger.error("Boardroom route failed", {
      routeKey: input.routeKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return new ApiError(500, "internal_error", "The request could not be completed").toResponse();
  }
}
