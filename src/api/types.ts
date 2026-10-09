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

export interface RoomDetail {
  room: Room;
  /** Active Participants in join order. */
  participants: ParticipantView[];
  /** The running or paused Round, or null. */
  activeRound: Round | null;
  workLinks: WorkLink[];
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
