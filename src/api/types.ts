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

/** Who wrote the Decision record. `name` is null when the member lookup holds no display name. */
export interface DecisionWriter {
  userId: string;
  name: string | null;
}

/** The Room's Decision record with its writer and time; the Room detail carries `null` when there is none. */
export interface DecisionView {
  markdown: string;
  writer: DecisionWriter;
  /** When it was last saved (ISO). */
  at: string;
}

export interface RoomDetail {
  room: Room;
  /** Active Participants in join order. */
  participants: ParticipantView[];
  /** The running or paused Round, or null. */
  activeRound: Round | null;
  workLinks: WorkLink[];
  /** The Decision record, or null when none is recorded. */
  decision: DecisionView | null;
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

export interface UpdateDecisionRequest {
  companyId: string;
  /** The markdown; an empty or blank string clears the record. */
  decisionMd: string;
}
