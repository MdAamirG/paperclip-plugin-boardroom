/** Response shapes of the plugin API. Type-only: the UI may import these. */
import type { Room, RoomSummary, Round, WorkLink } from "../db/index.js";
import type { CompanyRole } from "./access.js";

export type { Room, RoomSummary, Round, WorkLink };

export interface ParticipantView {
  id: string;
  agentId: string;
  /** From the agent record; null when the agent no longer exists. */
  name: string | null;
  role: string | null;
  title: string | null;
  addedByUserId: string;
  addedAt: string;
}

export interface RoomPermissions {
  /** The actor's company role. */
  role: CompanyRole;
  /** A non-viewer, and the Room is open. */
  canPost: boolean;
  /** The Room's Owner, or a company owner or admin. */
  canControl: boolean;
}

/** The live state of a linked issue, read through `ctx.issues` when the Room is loaded. */
export interface WorkIssueView {
  id: string;
  /** Human-readable identifier such as `PAP-12`; null before the host assigns one. */
  identifier: string | null;
  title: string;
  status: string;
  priority: string | null;
  assigneeAgentId: string | null;
  /** From the agent record; null when there is no agent assignee or it no longer exists. */
  assigneeAgentName: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
}

/** A work link with the issue it points to. `issue` is null when the issue can no longer be read. */
export type WorkLinkView = WorkLink & { issue: WorkIssueView | null };

export interface RoomDetail {
  room: Room;
  /** Active Participants in join order. */
  participants: ParticipantView[];
  /** The running or paused Round, or null. */
  activeRound: Round | null;
  /** Follow-up work, oldest first, with each issue read live. */
  workLinks: WorkLinkView[];
  permissions: RoomPermissions;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
  /** The actor's rights in this company, so the list can hide "New Room" from viewers. */
  permissions: { role: CompanyRole; canPost: boolean };
}

export interface CreateRoomRequest {
  companyId: string;
  title: string;
  topic: string;
  agentIds: string[];
  projectId?: string | null;
  linkedIssueId?: string | null;
  maxTotalTurns?: number | null;
}

export interface CreateWorkRequest {
  companyId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  priority?: "critical" | "high" | "medium" | "low" | null;
  /** Markdown body of the new issue's `plan` document. */
  plan?: string | null;
}

export interface CreateWorkResponse {
  workLink: WorkLinkView;
  issue: WorkIssueView;
  /** False when a plan was given but could not be saved; the issue and the link exist anyway. */
  planSaved: boolean;
  /** The host's reason when the plan was not saved. */
  planError?: string;
}

export interface AddWorkLinkRequest {
  companyId: string;
  issueId: string;
}

export interface RemoveWorkLinkResponse {
  removed: true;
  issueId: string;
}
