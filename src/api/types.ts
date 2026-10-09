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

/** One Message of the transcript. */
export interface MessageView {
  id: string;
  roomId: string;
  authorKind: "user" | "agent";
  /** A user id for `user`, an agent id for `agent` (kept after the agent is removed from the Room). */
  authorId: string;
  /**
   * The agent's name from the agent record; null for a user (the SDK has no user name lookup, so
   * the UI shows "You" or the short id) and for an agent that no longer exists.
   */
  authorName: string | null;
  body: string;
  createdAt: string;
  /** Agent Messages only. */
  roundId: string | null;
  turnId: string | null;
  runId: string | null;
}

/** `GET /rooms/:roomId/messages`. Query: `companyId`, `limit` (1..200, default 50), and at most one of `before` / `after` (a Message id). */
export interface MessageListResponse {
  /** Oldest first: the newest Message is last. */
  messages: MessageView[];
  /** More Messages in the direction paged: older for no cursor and `before`, newer for `after`. */
  hasMore: boolean;
}

export type IgnoredMentionReason = "not_a_participant" | "removed_participant" | "unknown_agent";

export interface IgnoredMention {
  agentId: string;
  /** The agent's name when it has one. */
  name: string | null;
  reason: IgnoredMentionReason;
}

/** `POST /rooms/:roomId/messages`. */
export interface SendMessageRequest {
  companyId: string;
  body: string;
  /** Agent ids picked in the composer, in the order written. */
  mentions?: string[];
  askAll?: boolean;
  /** Required. A repeated key in the same Room returns the original Message with status 200. */
  idempotencyKey: string;
}

export interface SendMessageResponse {
  message: MessageView;
  /** Always null until a Round can start (ticket 06). */
  round: Round | null;
  ignoredMentions: IgnoredMention[];
}
