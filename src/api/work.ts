/**
 * Follow-up work (ticket 12): create an ordinary issue that points back to the Room, link an
 * existing issue, and unlink either. Any non-viewer may do all three, also in a closed Room.
 */
import type { PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { BOARDROOM_PLUGIN_ID } from "../constants.js";
import { bumpRoomUpdatedAt, deleteWorkLink, getWorkLink, insertWorkLink, type Room } from "../db/index.js";
import { requireLevel } from "./access.js";
import { audit } from "./audit.js";
import type { RouteHandler } from "./context.js";
import { ApiError, badRequest, conflict, ok, unprocessable } from "./errors.js";
import { announceRoomChanged } from "./live.js";
import { loadRoom } from "./rooms.js";
import type { AddWorkLinkRequest, CreateWorkResponse, RemoveWorkLinkResponse } from "./types.js";
import { isUuid, optionalId, readBody, requiredString } from "./validation.js";
import { toWorkIssueView, withIssues } from "./work-view.js";

/** The origin kind of every issue the Boardroom creates: the plugin key form the host accepts (`plugin:<key>`). */
export const WORK_ORIGIN_KIND = `plugin:${BOARDROOM_PLUGIN_ID}` as const;
/** The document key the host's issue page shows as the plan. */
export const PLAN_DOCUMENT_KEY = "plan";

const ISSUE_TITLE_MAX = 500;
const DESCRIPTION_MAX = 50_000;
const PLAN_MAX = 200_000;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
type Priority = (typeof PRIORITIES)[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueNotInCompany(issueId: string) {
  return new ApiError(404, "issue_not_found", "That task does not exist in this company", { issueId });
}

interface ValidatedWork {
  title: string;
  description: string | undefined;
  projectId: string | undefined;
  assigneeAgentId: string | undefined;
  assigneeUserId: string | undefined;
  priority: Priority | undefined;
  plan: string | undefined;
}

function optionalText(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string`, { field });
  if (value.trim() === "") return undefined;
  if (value.length > max) throw badRequest(`"${field}" must be at most ${max} characters`, { field });
  return value;
}

function parseWorkBody(body: Record<string, unknown>): ValidatedWork {
  const priority = optionalId(body, "priority");
  if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority)) {
    throw badRequest(`"priority" must be one of ${PRIORITIES.join(", ")}`, { field: "priority" });
  }
  const assigneeAgentId = optionalId(body, "assigneeAgentId");
  const assigneeUserId = optionalId(body, "assigneeUserId");
  if (assigneeAgentId !== null && assigneeUserId !== null) {
    throw badRequest("A task has one assignee: send an agent or a user, not both", { field: "assigneeAgentId" });
  }
  return {
    title: requiredString(body, "title", ISSUE_TITLE_MAX),
    description: optionalText(body, "description", DESCRIPTION_MAX),
    projectId: optionalId(body, "projectId")?.toLowerCase(),
    assigneeAgentId: assigneeAgentId?.toLowerCase(),
    assigneeUserId: assigneeUserId ?? undefined,
    priority: (priority ?? undefined) as Priority | undefined,
    plan: optionalText(body, "plan", PLAN_MAX),
  };
}

/** A failure of the host's issue creation, as a response with the host's message and a matching status. */
function hostRejection(error: unknown): PluginApiResponse {
  const record = (error && typeof error === "object" ? error : {}) as { status?: unknown; statusCode?: unknown };
  const given = typeof record.status === "number" ? record.status : typeof record.statusCode === "number" ? record.statusCode : null;
  // The plugin RPC carries only the message and a numeric code, so the host's own HTTP status is
  // normally lost; a rejected input is then 422. A status the error does carry is kept.
  const status = given !== null && given >= 400 && given <= 599 ? given : 422;
  return { status, body: { error: "issue_create_failed", message: errorMessage(error) } };
}

export const createWork: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "post");
  const v = parseWorkBody(readBody(input));

  // The project defaults to the Room's. An explicit one must belong to the company: the host may
  // not check it, and a task filed under another company's project would be a boundary leak.
  const projectId = v.projectId ?? room.projectId ?? undefined;
  if (v.projectId !== undefined) {
    const project = isUuid(v.projectId) ? await ctx.projects.get(v.projectId, companyId) : null;
    if (!project || project.companyId !== companyId) {
      throw unprocessable("project_not_in_company", "The project does not belong to this company", { projectId: v.projectId });
    }
  }
  if (v.assigneeAgentId !== undefined) {
    const agent = isUuid(v.assigneeAgentId) ? await ctx.agents.get(v.assigneeAgentId, companyId) : null;
    if (!agent || agent.companyId !== companyId) {
      throw unprocessable("agent_not_in_company", "The assignee does not belong to this company", { agentId: v.assigneeAgentId });
    }
  }

  if (v.assigneeUserId !== undefined) {
    const members = await ctx.access.members.list({ companyId });
    const isMember = members.some(
      (m) => m.companyId === companyId && m.principalType === "user" && m.principalId === v.assigneeUserId && m.status === "active",
    );
    if (!isMember) {
      throw unprocessable("user_not_in_company", "The assignee is not an active member of this company", { userId: v.assigneeUserId });
    }
  }

  // Ordinary issue creation: the plugin origin is the back-link to the Room, and the acting user is
  // the creator and responsible user (the host sets both from `actor.actorUserId`).
  let issue;
  try {
    issue = await ctx.issues.create({
      companyId,
      title: v.title,
      ...(v.description !== undefined ? { description: v.description } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(v.assigneeAgentId !== undefined ? { assigneeAgentId: v.assigneeAgentId } : {}),
      ...(v.assigneeUserId !== undefined ? { assigneeUserId: v.assigneeUserId } : {}),
      ...(v.priority !== undefined ? { priority: v.priority } : {}),
      originKind: WORK_ORIGIN_KIND,
      originId: room.id,
      actor: { actorUserId: actor.userId },
    });
  } catch (error) {
    ctx.logger.warn("Boardroom could not create follow-up work", { roomId: room.id, error: errorMessage(error) });
    return hostRejection(error);
  }

  let link;
  try {
    link = await insertWorkLink(ctx.db, companyId, { roomId: room.id, issueId: issue.id, relation: "created", byUserId: actor.userId });
  } catch (error) {
    ctx.logger.error("Boardroom created a task but could not record its link", { roomId: room.id, issueId: issue.id, error: errorMessage(error) });
    throw new ApiError(500, "work_link_failed", `The task ${issue.identifier ?? issue.id} was created but could not be linked to the Room. Link it by hand.`, {
      issueId: issue.id,
    });
  }
  if (!link) throw new ApiError(500, "work_link_failed", "The task was created but the link was not recorded", { issueId: issue.id });

  // The issue and its link exist now, so a failed plan write is reported, not rolled back.
  let planSaved = v.plan === undefined;
  let planError: string | undefined;
  if (v.plan !== undefined) {
    try {
      await ctx.issues.documents.upsert({
        issueId: issue.id,
        companyId,
        key: PLAN_DOCUMENT_KEY,
        title: "Plan",
        format: "markdown",
        body: v.plan,
        changeSummary: `Plan from Room "${room.title}"`,
      });
      planSaved = true;
    } catch (error) {
      planError = errorMessage(error);
      ctx.logger.error("Boardroom could not write the plan document", { roomId: room.id, issueId: issue.id, error: planError });
    }
  }

  await touchAndAnnounce(ctx, room, actor.userId, "Work created", {
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    relation: "created",
    projectId: issue.projectId ?? null,
    planSaved: v.plan === undefined ? null : planSaved,
  });

  const view = await toWorkIssueView(ctx, issue);
  const body: CreateWorkResponse = { workLink: { ...link, issue: view }, issue: view, planSaved };
  if (planError !== undefined) body.planError = planError;
  return ok(body, 201);
};

export const addWorkLink: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "post");
  const body = readBody(input) as Partial<AddWorkLinkRequest>;
  const issueId = optionalId(body as Record<string, unknown>, "issueId")?.toLowerCase();
  if (!issueId) throw badRequest('"issueId" is required', { field: "issueId" });
  // Another company's issue and an unknown one look the same: 404.
  const issue = isUuid(issueId) ? await ctx.issues.get(issueId, companyId) : null;
  if (!issue || issue.companyId !== companyId) throw issueNotInCompany(issueId);

  const link = await insertWorkLink(ctx.db, companyId, { roomId: room.id, issueId: issue.id, relation: "linked", byUserId: actor.userId });
  if (!link) throw conflict("already_linked", "That task is already linked to this Room");

  await touchAndAnnounce(ctx, room, actor.userId, "Work linked", {
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    relation: "linked",
  });
  const [view] = await withIssues(ctx, companyId, [link]);
  return ok(view, 201);
};

export const removeWorkLink: RouteHandler = async ({ ctx, input, actor }) => {
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  requireLevel(actor, "post");
  const issueId = input.params.issueId?.toLowerCase();
  const existing = isUuid(issueId) ? await getWorkLink(ctx.db, companyId, room.id, issueId) : null;
  if (!existing) throw new ApiError(404, "work_link_not_found", "That task is not linked to this Room", { issueId: input.params.issueId ?? null });

  // Only the link goes: a task the Room created stays in the company.
  if (!(await deleteWorkLink(ctx.db, companyId, room.id, existing.issueId))) {
    throw new ApiError(404, "work_link_not_found", "That task is not linked to this Room", { issueId: existing.issueId });
  }
  await touchAndAnnounce(ctx, room, actor.userId, "Work unlinked", { issueId: existing.issueId, relation: existing.relation });
  return ok<RemoveWorkLinkResponse>({ removed: true, issueId: existing.issueId });
};

/** After the writes: move the Room up the list, write the activity entry, then announce once. */
async function touchAndAnnounce(
  ctx: PluginContext,
  room: Room,
  actingUserId: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await bumpRoomUpdatedAt(ctx.db, room.companyId, room.id);
  } catch (error) {
    ctx.logger.warn("Boardroom could not update the Room's time", { roomId: room.id, error: errorMessage(error) });
  }
  await audit(ctx, { companyId: room.companyId, actingUserId, roomId: room.id, message, metadata });
  announceRoomChanged(ctx, room.companyId, room.id);
}
