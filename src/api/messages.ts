import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  getMessage,
  getMessageByIdempotencyKey,
  insertMessage,
  listMessagesPage,
  touchRoom,
  type RoomMessage,
} from "../db/index.js";
import { requireLevel } from "./access.js";
import { audit } from "./audit.js";
import type { RouteHandler } from "./context.js";
import { badRequest, conflict, ok } from "./errors.js";
import { announceRoomChanged } from "./live.js";
import { resolveMentions } from "./mentions.js";
import { loadRoom } from "./rooms.js";
import type { MessageListResponse, MessageView, SendMessageResponse } from "./types.js";
import { isUuid, readBody, requiredString } from "./validation.js";

export const MESSAGE_BODY_MAX = 20_000;
export const IDEMPOTENCY_KEY_MAX = 200;
export const MENTIONS_MAX = 50;

/**
 * Messages with their author's name. Agent names come from `ctx.agents` (one lookup per agent,
 * even if the agent was removed from the Room, so attribution survives removal); a failed lookup
 * or a deleted agent gives `null`. User names are `null` (the SDK has no user name lookup).
 */
export async function toMessageViews(ctx: PluginContext, companyId: string, messages: readonly RoomMessage[]): Promise<MessageView[]> {
  const agentIds = [...new Set(messages.filter((m) => m.authorKind === "agent").map((m) => m.authorId))];
  const names = new Map<string, string | null>();
  await Promise.all(
    agentIds.map(async (agentId) => {
      if (!isUuid(agentId)) return names.set(agentId, null);
      try {
        names.set(agentId, (await ctx.agents.get(agentId, companyId))?.name ?? null);
      } catch (error) {
        ctx.logger.warn("Boardroom could not look up an agent name", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        names.set(agentId, null);
      }
    }),
  );
  return messages.map((m) => ({
    id: m.id,
    roomId: m.roomId,
    authorKind: m.authorKind,
    authorId: m.authorId,
    authorName: m.authorKind === "agent" ? (names.get(m.authorId) ?? null) : null,
    body: m.body,
    createdAt: m.createdAt,
    roundId: m.roundId,
    turnId: m.turnId,
    runId: m.runId,
  }));
}

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
  // `askAll` is validated now and acted on by the Round ticket; until then a send is always a note.
  if (raw.askAll !== undefined && raw.askAll !== null && typeof raw.askAll !== "boolean") {
    throw badRequest('"askAll" must be true or false', { field: "askAll" });
  }
  return { body, mentions, idempotencyKey };
}

/**
 * `POST /rooms/:roomId/messages`: save a note. Mentions are parsed and reported but start no
 * Round yet (ticket 06 turns valid mentions and `askAll` into one).
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
    return ok<SendMessageResponse>({ message: message!, round: null, ignoredMentions: ignored }, 200);
  };

  // Replay first: a send that was saved before the Room closed still answers with its original.
  const existing = await getMessageByIdempotencyKey(ctx.db, companyId, room.id, send.idempotencyKey);
  if (existing) return replay(existing);

  if (room.status === "closed") throw conflict("room_closed", "This Room is closed, so it no longer accepts messages");

  const { valid, ignored } = await resolveMentions(ctx, { companyId, roomId: room.id, body: send.body, mentions: send.mentions });

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

  try {
    // `rooms.updated_at` is never bumped by the database; a Message keeps the Room fresh.
    await touchRoom(ctx.db, companyId, room.id);
  } catch (error) {
    ctx.logger.warn("Boardroom could not mark a Room as updated", {
      roomId: room.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await audit(ctx, {
    companyId,
    actingUserId: actor.userId,
    roomId: room.id,
    message: "Message posted",
    metadata: { messageId: saved.id, mentionedAgentIds: valid, ignoredMentionCount: ignored.length },
  });
  announceRoomChanged(ctx, companyId, room.id);

  const [message] = await toMessageViews(ctx, companyId, [saved]);
  return ok<SendMessageResponse>({ message: message!, round: null, ignoredMentions: ignored }, 201);
};
