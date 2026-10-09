import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import { audit } from "../api/audit.js";
import { announceRoomChanged, touchRoomSafely } from "../api/live.js";
import { toMessageViews } from "../api/message-view.js";
import {
  countMessages,
  countUnfinishedTurns,
  finishRunningTurn,
  getRound,
  getRoom,
  getTurn,
  insertMessage,
  insertRound,
  insertTurn,
  listActiveParticipants,
  listMessagesPage,
  markPostedTurnFailed,
  nextRoundSeq,
  setRoundStatus,
  setTurnMessage,
  setTurnRunId,
  setTurnSession,
  startNextTurn,
  type Room,
  type Round,
  type RoomMessage,
  type Turn,
} from "../db/index.js";
import { buildTurnPrompt, type PromptMessage } from "./prompt.js";
import { isUuid } from "../api/validation.js";

/** How many of the latest Messages are read for the prompt; `fitTranscript` then trims to the character budget. */
const PROMPT_MESSAGE_FETCH = 200;

/** What a Turn ended with. `posted` carries the reply text. */
export type TurnSettlement =
  | { outcome: "posted"; text: string; runId?: string | null }
  | { outcome: "silent"; runId?: string | null }
  | { outcome: "failed"; runId?: string | null; hostMessage?: string | null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start a Round: one `queued` Turn per addressed agent (in the order given), then run the first.
 * `agentIds` must be unique active Participants (the caller checked). Returns `null` when the
 * Room already has an active Round (the unique index decided). Writes the "Round started" entry.
 */
export async function startRound(
  ctx: PluginContext,
  input: { room: Room; startedByUserId: string; triggerMessage: RoomMessage; agentIds: readonly string[]; askAll: boolean },
): Promise<Round | null> {
  const { room, triggerMessage } = input;
  const companyId = room.companyId;
  const seq = await nextRoundSeq(ctx.db, companyId, room.id);
  const round = await insertRound(ctx.db, companyId, {
    roomId: room.id,
    seq,
    startedByUserId: input.startedByUserId,
    triggerMessageId: triggerMessage.id,
    askAll: input.askAll,
    addressedAgentIds: [...input.agentIds],
  });
  if (!round) return null;
  for (const [index, agentId] of input.agentIds.entries()) {
    await insertTurn(ctx.db, companyId, { roundId: round.id, agentId, ord: index + 1 });
  }
  await touchRoomSafely(ctx, companyId, room.id);
  await audit(ctx, {
    companyId,
    actingUserId: input.startedByUserId,
    roomId: room.id,
    message: "Round started",
    metadata: {
      roundId: round.id,
      seq: round.seq,
      triggerMessageId: triggerMessage.id,
      addressedAgentIds: round.addressedAgentIds,
      askAll: round.askAll,
    },
  });
  announceRoomChanged(ctx, companyId, room.id);
  await advanceRound(ctx, companyId, round.id);
  return round;
}

/**
 * The one function that moves a Round forward; every ticket calls it (Round start, a Turn
 * finishing, Resume, the sweep). While the Round is `running` and no Turn is running it starts the
 * next queued Turn (lowest order); when no Turn is left unfinished it completes the Round. A paused,
 * stopped or completed Round is left alone. Safe to call twice: starting a Turn is a guarded
 * single statement.
 */
export async function advanceRound(ctx: PluginContext, companyId: string, roundId: string): Promise<void> {
  for (;;) {
    const round = await getRound(ctx.db, companyId, roundId);
    if (!round || round.status !== "running") return;

    const turn = await startNextTurn(ctx.db, companyId, roundId);
    if (turn) {
      announceRoomChanged(ctx, companyId, round.roomId);
      const stillRunning = await dispatchTurn(ctx, round, turn);
      if (stillRunning) return;
      continue; // The Turn failed to start and is already settled: look at the next one.
    }
    if ((await countUnfinishedTurns(ctx.db, companyId, roundId)) > 0) return; // A Turn is running.

    const completed = await setRoundStatus(ctx.db, companyId, roundId, "completed", { expectedFrom: ["running"] });
    if (completed) {
      await touchRoomSafely(ctx, companyId, round.roomId);
      await audit(ctx, {
        companyId,
        actingUserId: null,
        roomId: round.roomId,
        message: "Round completed",
        metadata: { roundId, seq: round.seq },
      });
      announceRoomChanged(ctx, companyId, round.roomId);
    }
    return;
  }
}

/**
 * Run one Turn: a new session, one prompt, the run id kept on the Turn. Returns true while the
 * Turn is waiting for the agent, false when it could not start and was settled as failed (the
 * caller then continues with the next Turn). A Turn is never retried.
 */
async function dispatchTurn(ctx: PluginContext, round: Round, turn: Turn): Promise<boolean> {
  const companyId = round.companyId;
  try {
    const room = await getRoom(ctx.db, companyId, round.roomId);
    if (!room) throw new Error("The Room no longer exists");
    const prompt = await buildPrompt(ctx, room, round, turn);
    const reason = `Boardroom: ${room.title}`;
    const session = await ctx.agents.sessions.create(turn.agentId, companyId, { reason });
    await setTurnSession(ctx.db, companyId, turn.id, session.sessionId);
    const { runId } = await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
      prompt,
      reason,
      onEvent: (event) => handleSessionEvent(ctx, companyId, turn.id, event),
    });
    try {
      await setTurnRunId(ctx.db, companyId, turn.id, runId);
    } catch (error) {
      // The agent is already running; the run id also arrives with its completion event.
      ctx.logger.warn("Boardroom could not store a run id", { turnId: turn.id, runId, error: errorMessage(error) });
    }
    return true;
  } catch (error) {
    ctx.logger.warn("Boardroom could not run a Turn", { turnId: turn.id, error: errorMessage(error) });
    // Ticket 07 turns a rejected send into a skipped Turn; until then it is a failed one.
    await settleTurn(ctx, companyId, turn.id, { outcome: "failed", hostMessage: errorMessage(error) }, { advance: false });
    return false;
  }
}

async function agentLabel(ctx: PluginContext, companyId: string, agentId: string): Promise<{ name: string; role: string | null }> {
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    if (agent) return { name: agent.name, role: agent.role ?? null };
  } catch (error) {
    ctx.logger.warn("Boardroom could not look up an agent for a prompt", { agentId, error: errorMessage(error) });
  }
  return { name: `Agent ${agentId.slice(0, 8)}`, role: null };
}

async function buildPrompt(ctx: PluginContext, room: Room, round: Round, turn: Turn): Promise<string> {
  const companyId = room.companyId;
  const [participants, page, total] = await Promise.all([
    listActiveParticipants(ctx.db, companyId, room.id),
    listMessagesPage(ctx.db, companyId, room.id, { limit: PROMPT_MESSAGE_FETCH }),
    countMessages(ctx.db, companyId, room.id),
  ]);
  const labels = new Map<string, { name: string; role: string | null }>();
  for (const agentId of new Set([...participants.map((p) => p.agentId), ...round.addressedAgentIds, turn.agentId])) {
    labels.set(agentId.toLowerCase(), await agentLabel(ctx, companyId, agentId));
  }
  const label = (agentId: string) => labels.get(agentId.toLowerCase())!;
  const views = await toMessageViews(ctx, companyId, page.messages);
  const messages: PromptMessage[] = views.map((m) => ({
    author:
      m.authorKind === "agent"
        ? (m.authorName ?? "A former participant")
        : m.authorId === room.ownerUserId
          ? "Owner"
          : "Board member",
    body: m.body,
  }));
  return buildTurnPrompt({
    roomTitle: room.title,
    topic: room.topic,
    participants: participants.map((p) => label(p.agentId)),
    agentName: label(turn.agentId).name,
    addressedNames: round.addressedAgentIds.map((id) => label(id).name),
    messages,
    omittedCount: total - messages.length,
  });
}

/** Turn a live session event into a settlement. Only `done` and `error` end a Turn. */
function handleSessionEvent(ctx: PluginContext, companyId: string, turnId: string, event: AgentSessionEvent): void {
  let settlement: TurnSettlement;
  if (event.eventType === "done") {
    const text = event.message ?? "";
    settlement = text.trim() === "" ? { outcome: "silent", runId: event.runId } : { outcome: "posted", text, runId: event.runId };
  } else if (event.eventType === "error") {
    settlement = { outcome: "failed", runId: event.runId, hostMessage: event.message };
  } else {
    return;
  }
  void settleTurn(ctx, companyId, turnId, settlement).catch((error: unknown) => {
    ctx.logger.error("Boardroom could not settle a Turn", { turnId, error: errorMessage(error) });
  });
}

/**
 * Settle a running Turn from any signal (the live event today; the run event and the sweep later).
 * Settle-once: the first signal wins through a conditional update (`WHERE status = 'running'`); any
 * later one returns false and changes nothing. The winner saves the reply Message (for `posted`),
 * writes the system activity entry, closes the session and advances the Round (unless
 * `advance: false`, used when the caller advances itself).
 */
export async function settleTurn(
  ctx: PluginContext,
  companyId: string,
  turnId: string,
  settlement: TurnSettlement,
  options: { advance?: boolean } = {},
): Promise<boolean> {
  const claimedRunId = isUuid(settlement.runId) ? settlement.runId : null;
  const won = await finishRunningTurn(ctx.db, companyId, turnId, {
    outcome: settlement.outcome,
    runId: claimedRunId,
    hostMessage: settlement.outcome === "failed" ? (settlement.hostMessage ?? null) : null,
  });
  if (!won) return false;

  const turn = await getTurn(ctx.db, companyId, turnId);
  if (!turn) return true;
  const round = await getRound(ctx.db, companyId, turn.roundId);
  if (!round) return true;

  let outcome: TurnSettlement["outcome"] = settlement.outcome;
  let hostMessage = settlement.outcome === "failed" ? (settlement.hostMessage ?? null) : null;
  let messageId: string | null = null;
  if (settlement.outcome === "posted") {
    try {
      const message = await insertMessage(ctx.db, companyId, {
        roomId: round.roomId,
        authorKind: "agent",
        authorId: turn.agentId,
        body: settlement.text,
        roundId: round.id,
        turnId: turn.id,
        runId: turn.runId,
      });
      if (!message) throw new Error("The reply was not saved");
      messageId = message.id;
      await setTurnMessage(ctx.db, companyId, turn.id, message.id);
      await touchRoomSafely(ctx, companyId, round.roomId);
    } catch (error) {
      ctx.logger.error("Boardroom could not save a reply", { turnId, error: errorMessage(error) });
      outcome = "failed";
      hostMessage = "The reply could not be saved";
      await markPostedTurnFailed(ctx.db, companyId, turn.id, hostMessage).catch(() => false);
    }
  }

  await audit(ctx, {
    companyId,
    actingUserId: null,
    roomId: round.roomId,
    message: `Turn ${outcome}`,
    metadata: {
      roundId: round.id,
      turnId: turn.id,
      agentId: turn.agentId,
      runId: turn.runId,
      outcome,
      messageId,
      ...(hostMessage ? { hostMessage } : {}),
    },
  });

  if (turn.sessionId) {
    try {
      await ctx.agents.sessions.close(turn.sessionId, companyId);
    } catch (error) {
      ctx.logger.warn("Boardroom could not close a session", { turnId, sessionId: turn.sessionId, error: errorMessage(error) });
    }
  }
  announceRoomChanged(ctx, companyId, round.roomId);
  if (options.advance !== false) await advanceRound(ctx, companyId, round.id);
  return true;
}
