import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  MAX_ACTIVE_PARTICIPANTS,
  MAX_MAX_TOTAL_TURNS,
  MIN_MAX_TOTAL_TURNS,
  deleteRoom,
  getActiveRound,
  getRoom,
  insertInitialParticipants,
  insertRoom,
  insertWorkLink,
  listActiveParticipants,
  listRoomSummaries,
  type Room,
} from "../db/index.js";
import { canControl, canPost, requireLevel, type Actor } from "./access.js";
import { audit } from "./audit.js";
import type { RouteContext, RouteHandler } from "./context.js";
import { ApiError, badRequest, ok, roomNotFound, unprocessable } from "./errors.js";
import { announceRoomChanged } from "./live.js";
import { decisionViewFor } from "./decision-view.js";
import type { ParticipantView, RoomDetail, RoomListResponse } from "./types.js";
import { isUuid, optionalId, readBody, requiredString } from "./validation.js";
import { toRoundViews } from "./round-view.js";
import { listWorkLinkViews } from "./work-view.js";

const TITLE_MAX = 200;
const TOPIC_MAX = 10_000;

/** A Room of this company, or 404. A malformed id is a 404 too (it cannot name a Room). */
export async function loadRoom(ctx: PluginContext, companyId: string, roomId: string | undefined): Promise<Room> {
  if (!isUuid(roomId)) throw roomNotFound();
  const room = await getRoom(ctx.db, companyId, roomId);
  if (!room) throw roomNotFound();
  return room;
}

export function permissionsFor(actor: Actor, room: Room) {
  return { role: actor.role, canPost: canPost(actor) && room.status === "open", canControl: canControl(actor, room) && canPost(actor) };
}

/** The Room with its active Participants (agent name and role), active Round and work links. */
export async function buildRoomDetail(ctx: PluginContext, actor: Actor, room: Room): Promise<RoomDetail> {
  const db = ctx.db;
  const [participants, activeRound, workLinks] = await Promise.all([
    listActiveParticipants(db, room.companyId, room.id),
    getActiveRound(db, room.companyId, room.id),
    listWorkLinkViews(ctx, room.companyId, room.id),
  ]);
  // Fetch the names in parallel. The Room is already committed by now (create calls this after the
  // writes), so a failed lookup must not turn into a 500: that Participant just has no name.
  const views: ParticipantView[] = await Promise.all(
    participants.map(async (participant) => {
      const agent = await ctx.agents.get(participant.agentId, room.companyId).catch((error: unknown) => {
        ctx.logger.warn("Boardroom could not look up an agent name", { agentId: participant.agentId, error: errorMessage(error) });
        return null;
      });
      return {
        id: participant.id,
        agentId: participant.agentId,
        name: agent?.name ?? null,
        role: agent?.role ?? null,
        title: agent?.title ?? null,
        addedByUserId: participant.addedByUserId,
        addedAt: participant.addedAt,
      };
    }),
  );
  const decision = await decisionViewFor(ctx, room);
  const [activeRoundView] = await toRoundViews(ctx, room.companyId, room.id, activeRound ? [activeRound] : []);
  return { room, participants: views, activeRound: activeRoundView ?? null, workLinks, decision, permissions: permissionsFor(actor, room) };
}

export const listRooms: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const rooms = await listRoomSummaries(ctx.db, input.companyId);
  return ok<RoomListResponse>({ rooms, permissions: { role: actor.role, canPost: canPost(actor) } });
};

export const getRoomDetail: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const room = await loadRoom(ctx, input.companyId, input.params.roomId);
  return ok(await buildRoomDetail(ctx, actor, room));
};

interface ValidatedCreate {
  title: string;
  topic: string;
  agentIds: string[];
  projectId: string | null;
  linkedIssueId: string | null;
  maxTotalTurns: number | undefined;
}

/** Shape (400) and numeric rules (422) that need no lookups. */
function parseCreateBody(body: Record<string, unknown>): ValidatedCreate {
  const title = requiredString(body, "title", TITLE_MAX);
  const topic = requiredString(body, "topic", TOPIC_MAX);

  const rawAgents = body.agentIds;
  if (!Array.isArray(rawAgents) || rawAgents.some((id) => typeof id !== "string")) {
    throw badRequest('"agentIds" must be an array of agent ids', { field: "agentIds" });
  }
  // Ids are compared and stored in lower case, so "ABC..." and "abc..." are one agent.
  const agentIds = (rawAgents as string[]).map((id) => id.toLowerCase());
  if (agentIds.length > MAX_ACTIVE_PARTICIPANTS) {
    throw unprocessable("too_many_participants", `A Room has at most ${MAX_ACTIVE_PARTICIPANTS} Participants`, {
      limit: MAX_ACTIVE_PARTICIPANTS,
      given: agentIds.length,
    });
  }
  if (agentIds.length === 0) throw unprocessable("participants_required", "Pick at least one agent");
  if (new Set(agentIds).size !== agentIds.length) {
    throw unprocessable("duplicate_participant", "An agent can be picked only once");
  }

  let maxTotalTurns: number | undefined;
  const cap = body.maxTotalTurns;
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== "number") throw badRequest('"maxTotalTurns" must be a number', { field: "maxTotalTurns" });
    if (!Number.isInteger(cap) || cap < MIN_MAX_TOTAL_TURNS || cap > MAX_MAX_TOTAL_TURNS) {
      throw unprocessable(
        "turn_cap_out_of_range",
        `The turn cap must be a whole number from ${MIN_MAX_TOTAL_TURNS} to ${MAX_MAX_TOTAL_TURNS}`,
        { min: MIN_MAX_TOTAL_TURNS, max: MAX_MAX_TOTAL_TURNS },
      );
    }
    maxTotalTurns = cap;
  }
  return {
    title,
    topic,
    agentIds,
    projectId: optionalId(body, "projectId"),
    linkedIssueId: optionalId(body, "linkedIssueId"),
    maxTotalTurns,
  };
}

/** Every referenced record must belong to the company; the tables hold no foreign keys to them. */
async function assertReferencesInCompany(ctx: PluginContext, companyId: string, v: ValidatedCreate): Promise<void> {
  for (const agentId of v.agentIds) {
    const agent = isUuid(agentId) ? await ctx.agents.get(agentId, companyId) : null;
    if (!agent || agent.companyId !== companyId) {
      throw unprocessable("agent_not_in_company", "An agent you picked does not belong to this company", { agentId });
    }
  }
  if (v.projectId !== null) {
    const project = isUuid(v.projectId) ? await ctx.projects.get(v.projectId, companyId) : null;
    if (!project || project.companyId !== companyId) {
      throw unprocessable("project_not_in_company", "The project does not belong to this company", { projectId: v.projectId });
    }
  }
  if (v.linkedIssueId !== null) {
    const issue = isUuid(v.linkedIssueId) ? await ctx.issues.get(v.linkedIssueId, companyId) : null;
    if (!issue || issue.companyId !== companyId) {
      throw unprocessable("issue_not_in_company", "The linked issue does not belong to this company", {
        issueId: v.linkedIssueId,
      });
    }
  }
}

export const createRoom: RouteHandler = async ({ ctx, input, actor }: RouteContext) => {
  requireLevel(actor, "post");
  const companyId = input.companyId;
  const v = parseCreateBody(readBody(input));
  await assertReferencesInCompany(ctx, companyId, v);

  let room: Room;
  try {
    room = await insertRoom(ctx.db, companyId, {
      title: v.title,
      topic: v.topic,
      ownerUserId: actor.userId,
      projectId: v.projectId,
      maxTotalTurns: v.maxTotalTurns,
    });
  } catch (error) {
    ctx.logger.error("Boardroom could not create a Room", { error: errorMessage(error) });
    throw new ApiError(500, "internal_error", "The Room could not be created");
  }
  try {
    // ctx.db has no transactions, so the create is not atomic. Every Participant goes in with ONE
    // statement (all or none), which leaves one failure window between the Room and its
    // Participants. Join order is the explicit `position`, the order given.
    await insertInitialParticipants(ctx.db, companyId, { roomId: room.id, agentIds: v.agentIds, addedByUserId: actor.userId });
    if (v.linkedIssueId !== null) {
      await insertWorkLink(ctx.db, companyId, {
        roomId: room.id,
        issueId: v.linkedIssueId,
        relation: "linked",
        byUserId: actor.userId,
      });
    }
  } catch (error) {
    ctx.logger.error("Boardroom could not finish creating a Room", { roomId: room.id, error: errorMessage(error) });
    // Do not leave a half-built Room behind. If even this fails, the Room stays with no
    // Participants; say so loudly so it can be found (the later sweep removes such Rooms).
    try {
      await deleteRoom(ctx.db, companyId, room.id);
    } catch (rollbackError) {
      ctx.logger.error("Boardroom could not roll back a half-built Room; it is left without Participants", {
        roomId: room.id,
        companyId,
        error: errorMessage(rollbackError),
      });
    }
    throw new ApiError(500, "internal_error", "The Room could not be created");
  }

  await audit(ctx, {
    companyId,
    actingUserId: actor.userId,
    roomId: room.id,
    message: "Room created",
    metadata: {
      title: room.title,
      topic: room.topic,
      projectId: room.projectId,
      maxTotalTurns: room.maxTotalTurns,
      ownerUserId: room.ownerUserId,
    },
  });
  for (const agentId of v.agentIds) {
    await audit(ctx, {
      companyId,
      actingUserId: actor.userId,
      roomId: room.id,
      message: "Participant added",
      metadata: { agentId },
    });
  }
  if (v.linkedIssueId !== null) {
    await audit(ctx, {
      companyId,
      actingUserId: actor.userId,
      roomId: room.id,
      message: "Work linked",
      metadata: { issueId: v.linkedIssueId, relation: "linked" },
    });
  }
  announceRoomChanged(ctx, companyId, room.id);

  return ok(await buildRoomDetail(ctx, actor, room), 201);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
