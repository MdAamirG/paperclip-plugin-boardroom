/** Builders for the API shapes the UI tests mock. */
import type { MessageView, Room, RoomDetail, RoomSummary, RoundView, TurnView } from "../../src/api/types.js";
import type { HostAgent } from "../../src/ui/api.js";

export const COMPANY_ID = "company-1";

export function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    id: "room-1",
    companyId: COMPANY_ID,
    title: "Raise prices?",
    topic: "Should we raise prices by 10 percent next quarter?",
    projectId: null,
    ownerUserId: "user-owner-1",
    status: "open",
    maxTotalTurns: 40,
    decisionMd: null,
    decisionByUserId: null,
    decisionAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

export function summaryFixture(overrides: Partial<RoomSummary> = {}): RoomSummary {
  const room = roomFixture(overrides);
  return { ...room, participantCount: 3, lastActivityAt: "2026-10-02T10:30:00.000Z", ...overrides };
}

export function detailFixture(overrides: Partial<Omit<RoomDetail, "room">> & { room?: Partial<Room> } = {}): RoomDetail {
  const { room, ...rest } = overrides;
  return {
    room: roomFixture(room),
    participants: [
      { id: "p1", agentId: "agent-1", name: "Ada", role: "cto", title: "Chief Technology Officer", addedByUserId: "user-owner-1", addedAt: "2026-10-01T09:00:00.000Z" },
      { id: "p2", agentId: "agent-2", name: "Grace", role: "engineer", title: null, addedByUserId: "user-owner-1", addedAt: "2026-10-01T09:00:00.000Z" },
    ],
    activeRound: null,
    workLinks: [],
    decision: null,
    permissions: { role: "owner", canPost: true, canControl: true },
    ...rest,
  };
}

export function agentFixture(name: string, overrides: Partial<HostAgent> = {}): HostAgent {
  return { id: `agent-${name.toLowerCase()}`, name, role: "engineer", title: null, status: "idle", ...overrides };
}

export const LIST_PERMISSIONS = {
  owner: { role: "owner", canPost: true },
  viewer: { role: "viewer", canPost: false },
} as const;

export function messageFixture(overrides: Partial<MessageView> = {}): MessageView {
  const id = overrides.id ?? "m1";
  return {
    id,
    roomId: "room-1",
    authorKind: "user",
    authorId: "user-owner-1",
    authorName: null,
    body: `Body of ${id}`,
    createdAt: "2026-10-01T09:00:00.000Z",
    roundId: null,
    turnId: null,
    runId: null,
    ...overrides,
  };
}

export function turnFixture(overrides: Partial<TurnView> = {}): TurnView {
  return {
    id: "t1",
    roundId: "r1",
    agentId: "agent-1",
    agentName: "Ada",
    ord: 1,
    status: "queued",
    outcome: null,
    skipReason: null,
    hostMessage: null,
    runId: null,
    messageId: null,
    startedAt: null,
    finishedAt: null,
    cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, events: 0, subscriptionBilled: false },
    ...overrides,
  };
}

export function roundFixture(overrides: Partial<RoundView> = {}): RoundView {
  const turns = overrides.turns ?? [turnFixture()];
  return {
    id: "r1",
    companyId: COMPANY_ID,
    roomId: "room-1",
    seq: 1,
    startedByUserId: "user-owner-1",
    triggerMessageId: "m1",
    askAll: false,
    addressedAgentIds: turns.map((t) => t.agentId),
    status: "running",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    endedAt: null,
    ...overrides,
    turns,
  };
}
