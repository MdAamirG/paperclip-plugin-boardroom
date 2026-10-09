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

/** What a Turn's run cost, summed from the host's cost events. All zero when the run has no cost events (yet). */
export interface CostFigures {
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** A Turn's own cost. `subscriptionBilled`: it has cost events and every one is subscription billed with zero cents. */
export interface TurnCost extends CostFigures {
  /** Number of cost events behind the figures. */
  events: number;
  subscriptionBilled: boolean;
}

/** One Turn of a Round as the UI shows it. The session id stays inside the plugin. */
export interface TurnView {
  id: string;
  roundId: string;
  agentId: string;
  /** From the agent record; null when the agent no longer exists. */
  agentName: string | null;
  /** 1-based order within the Round. */
  ord: number;
  status: "queued" | "running" | "finished";
  /** Set exactly when `status` is `finished`. */
  outcome: "posted" | "silent" | "failed" | "skipped" | null;
  skipReason: "not_invokable" | "stopped" | null;
  /** The host's message, word for word (a rejected send; the failure text of a failed Turn). */
  hostMessage: string | null;
  runId: string | null;
  /** The Message a posted Turn saved. */
  messageId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cost: TurnCost;
}

/** A Round with its Turns in order. */
export type RoundView = Round & { turns: TurnView[] };

/** `GET /rooms/:roomId/rounds`: newest Round first. */
export interface RoundListResponse {
  rounds: RoundView[];
}

export interface RoomDetail {
  room: Room;
  /** Active Participants in join order. */
  participants: ParticipantView[];
  /** The running or paused Round with its Turns, or null. */
  activeRound: RoundView | null;
  /** Follow-up work, oldest first, with each issue read live. */
  workLinks: WorkLinkView[];
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
  /**
   * The Round this send started (as it is after its first Turn started), or null for a note.
   * A replay returns the original Round again and starts nothing.
   */
  round: RoundView | null;
  ignoredMentions: IgnoredMention[];
}

export interface UpdateDecisionRequest {
  companyId: string;
  /** The markdown; an empty or blank string clears the record. */
  decisionMd: string;
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

/** Turn counts by outcome. Queued and running Turns have no outcome yet and are in none of these. */
export interface OutcomeCounts {
  posted: number;
  silent: number;
  failed: number;
  skipped: number;
}

/** One agent's share of a Room's cost: every agent that ever had a Turn, removed Participants included. */
export interface AgentCost extends CostFigures {
  agentId: string;
  /** From the agent record; null when the agent no longer exists. */
  agentName: string | null;
  isActiveParticipant: boolean;
  /** Turns with cost events (distinct runs). */
  runCount: number;
  outcomes: OutcomeCounts;
  subscriptionBilled: boolean;
}

/** `GET /rooms/:roomId/costs`. */
export interface RoomCostsResponse extends CostFigures {
  roomId: string;
  /** Distinct runs with at least one cost event. */
  runCount: number;
  subscriptionBilled: boolean;
  /** Counted Turns (every Turn that was not skipped), as the cap counts them. */
  turnsUsed: number;
  maxTotalTurns: number;
  agents: AgentCost[];
}
