import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  getMessage,
  getMessageByIdempotencyKey,
  countCountedTurns,
  getActiveRound,
  getRound,
  getRoundByTriggerMessage,
  insertMessage,
  listMessagesPage,
  type RoomMessage,
} from "../db/index.js";
import { startRound } from "../engine/rounds.js";
import { canControl, canPost, requireLevel } from "./access.js";
import { audit } from "./audit.js";
import type { RouteHandler } from "./context.js";
import { badRequest, conflict, forbidden, ok, unprocessable } from "./errors.js";
import { announceRoomChanged, touchRoomSafely } from "./live.js";
import { resolveMentions } from "./mentions.js";
import { toMessageViews } from "./message-view.js";
import { toRoundViews } from "./round-view.js";
import { loadRoom } from "./rooms.js";
import type { MessageListResponse, MessageView, SendMessageResponse } from "./types.js";
import { isUuid, readBody, requiredString } from "./validation.js";

export { toMessageViews };
export const MESSAGE_BODY_MAX = 20_000;
export const IDEMPOTENCY_KEY_MAX = 200;
export const MENTIONS_MAX = 50;

function queryValue(input: { query: Record<string, string | string[]> }, key: string): string | undefined {
  const value = input.query[key];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === "" ? undefined : single;
}

/** `GET /rooms/:roomId/messages`: a page of the transcript, oldest first. */
export const listRoomMessages: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const room = await loadRoom(ctx, input.companyId, input.params.roomId);

  let limit = DEFAULT_MESSAGE_PAGE_SIZE;
  const rawLimit = queryValue(input, "limit");
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_MESSAGE_PAGE_SIZE) {
      throw badRequest(`"limit" must be a whole number from 1 to ${MAX_MESSAGE_PAGE_SIZE}`, { field: "limit" });
    }
  }
  const before = queryValue(input, "before");
  const after = queryValue(input, "after");
  if (before !== undefined && after !== undefined) throw badRequest('Use either "before" or "after", not both', { field: "after" });
  const cursor = before ?? after;
  if (cursor !== undefined) {
    const field = before !== undefined ? "before" : "after";
    // The cursor must be a Message of this Room, so an id from another Room cannot probe it.
    const found = isUuid(cursor) ? await getMessage(ctx.db, input.companyId, cursor) : null;
    if (!found || found.roomId !== room.id) throw badRequest(`"${field}" must be the id of a Message in this Room`, { field });
  }

  const page = await listMessagesPage(ctx.db, input.companyId, room.id, {
    limit,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });
  return ok<MessageListResponse>({ messages: await toMessageViews(ctx, input.companyId, page.messages), hasMore: page.hasMore });
};

interface ValidatedSend {
  body: string;
  /** Validated; "Ask all" is acted on by the multi-agent ticket. */
  askAll: boolean;
  mentions: string[];
  idempotencyKey: string;
}

function parseSendBody(raw: Record<string, unknown>): ValidatedSend {
  const idempotencyKey = requiredString(raw, "idempotencyKey", IDEMPOTENCY_KEY_MAX);
  const body = requiredString(raw, "body", MESSAGE_BODY_MAX);
  const rawMentions = raw.mentions;
  let mentions: string[] = [];
  if (rawMentions !== undefined && rawMentions !== null) {
    if (!Array.isArray(rawMentions) || rawMentions.some((id) => typeof id !== "string")) {
      throw badRequest('"mentions" must be an array of agent ids', { field: "mentions" });
    }
    if (rawMentions.length > MENTIONS_MAX) {
      throw badRequest(`"mentions" has at most ${MENTIONS_MAX} entries`, { field: "mentions" });
    }
    mentions = rawMentions as string[];
  }
  if (raw.askAll !== undefined && raw.askAll !== null && typeof raw.askAll !== "boolean") {
    throw badRequest('"askAll" must be true or false', { field: "askAll" });
  }
  return { body, mentions, askAll: raw.askAll === true, idempotencyKey };
}

/**
 * `POST /rooms/:roomId/messages`: save a note; valid mentions of active Participants also start a
 * Round (one Turn each, in the order mentioned). "Ask all" is not acted on yet.
 *
 * Starting a Round needs `control` (403 `round_not_allowed`), no active Round (409 `round_active`)
 * and room under the turn cap (422 `turn_cap_reached`); these are checked before anything is
 * saved. If a concurrent send wins the Round slot after the checks, the note stays saved and this
 * send answers 409 `round_active` (a retry with the same key replays the note without a Round).
 *
 * Idempotency: a key already used in this Room returns that Message with status 200 and writes
 * nothing (no activity entry, no event). The ignored mentions are not stored, so a replay
 * recomputes them from the repeated request against the Room as it is now.
 */
export const sendMessage: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "post");
  const companyId = input.companyId;
  const room = await loadRoom(ctx, companyId, input.params.roomId);
  const send = parseSendBody(readBody(input));

  const replay = async (original: RoomMessage) => {
    if (original.authorId !== actor.userId) {
      throw conflict("idempotency_key_in_use", "This idempotency key was used by another send in this Room");
    }
    const { ignored } = await resolveMentions(ctx, { companyId, roomId: room.id, body: send.body, mentions: send.mentions });
    const [message] = await toMessageViews(ctx, companyId, [original]);
    // The Round this Message started, as it is now; nothing is started again.
    const started = await getRoundByTriggerMessage(ctx.db, companyId, room.id, original.id);
    const [round] = await toRoundViews(ctx, companyId, room.id, started ? [started] : []);
    return ok<SendMessageResponse>({ message: message!, round: round ?? null, ignoredMentions: ignored }, 200);
  };

  // Replay first: a send that was saved before the Room closed still answers with its original.
  const existing = await getMessageByIdempotencyKey(ctx.db, companyId, room.id, send.idempotencyKey);
  if (existing) return replay(existing);

  if (room.status === "closed") throw conflict("room_closed", "This Room is closed, so it no longer accepts messages");

  const { valid, ignored } = await resolveMentions(ctx, { companyId, roomId: room.id, body: send.body, mentions: send.mentions });

  if (valid.length > 0) {
    if (!(canPost(actor) && canControl(actor, room))) {
      throw forbidden("round_not_allowed", "Only the Room Owner or a company owner or admin can start a Round by mentioning agents");
    }
    if (await getActiveRound(ctx.db, companyId, room.id)) {
      throw conflict("round_active", "This Room already has a Round in progress");
    }
    const counted = await countCountedTurns(ctx.db, companyId, room.id);
    if (counted + valid.length > room.maxTotalTurns) {
      throw unprocessable("turn_cap_reached", `This would pass the Room's limit of ${room.maxTotalTurns} Turns`, {
        cap: room.maxTotalTurns,
        counted,
        requested: valid.length,
      });
    }
  }

  const saved = await insertMessage(ctx.db, companyId, {
    roomId: room.id,
    authorKind: "user",
    authorId: actor.userId,
    body: send.body,
    idempotencyKey: send.idempotencyKey,
  });
  if (!saved) {
    // A concurrent send with the same key won the insert.
    const winner = await getMessageByIdempotencyKey(ctx.db, companyId, room.id, send.idempotencyKey);
    if (winner) return replay(winner);
    throw new Error("The Message was neither saved nor found by its idempotency key");
  }

  // `rooms.updated_at` is never bumped by the database; a Message keeps the Room fresh.
  await touchRoomSafely(ctx, companyId, room.id);
  await audit(ctx, {
    companyId,
    actingUserId: actor.userId,
    roomId: room.id,
    message: "Message posted",
    metadata: { messageId: saved.id, mentionedAgentIds: valid, ignoredMentionCount: ignored.length },
  });
  announceRoomChanged(ctx, companyId, room.id);

  let round: Awaited<ReturnType<typeof toRoundViews>>[number] | null = null;
  if (valid.length > 0) {
    const started = await startRound(ctx, { room, startedByUserId: actor.userId, triggerMessage: saved, agentIds: valid, askAll: send.askAll });
    if (!started) throw conflict("round_active", "This Room already has a Round in progress. Your note was saved without a Round.");
    // Read the Round again: starting it also ran its first Turn.
    const current = await getRound(ctx.db, companyId, started.id);
    [round = null] = await toRoundViews(ctx, companyId, room.id, current ? [current] : []);
  }

  const [message] = await toMessageViews(ctx, companyId, [saved]);
  return ok<SendMessageResponse>({ message: message!, round, ignoredMentions: ignored }, 201);
};
