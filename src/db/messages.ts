import { randomUUID } from "node:crypto";
import { type Db, type Row, selectMany, selectOne, str, strOrNull, table } from "./sql.js";

export type MessageAuthorKind = "user" | "agent";

export interface RoomMessage {
  id: string;
  companyId: string;
  roomId: string;
  authorKind: MessageAuthorKind;
  /** A user id for `user`, an agent id for `agent`. */
  authorId: string;
  body: string;
  roundId: string | null;
  turnId: string | null;
  runId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export function mapMessage(row: Row): RoomMessage {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    roomId: str(row.room_id),
    authorKind: str(row.author_kind) as MessageAuthorKind,
    authorId: str(row.author_id),
    body: str(row.body),
    roundId: strOrNull(row.round_id),
    turnId: strOrNull(row.turn_id),
    runId: strOrNull(row.run_id),
    idempotencyKey: strOrNull(row.idempotency_key),
    createdAt: str(row.created_at),
  };
}

export interface NewMessage {
  roomId: string;
  authorKind: MessageAuthorKind;
  authorId: string;
  body: string;
  /** Agent Messages must set the Round and Turn; user Messages must not (check constraint). */
  roundId?: string | null;
  turnId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Save a Message. Returns `null` when the Room already has a Message with this idempotency key
 * (read the original with `getMessageByIdempotencyKey`). Messages without a key never conflict.
 */
export async function insertMessage(db: Db, companyId: string, input: NewMessage): Promise<RoomMessage | null> {
  const id = randomUUID();
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "room_messages")}
       (id, company_id, room_id, author_kind, author_id, body, round_id, turn_id, run_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (room_id, idempotency_key) DO NOTHING`,
    [
      id,
      companyId,
      input.roomId,
      input.authorKind,
      input.authorId,
      input.body,
      input.roundId ?? null,
      input.turnId ?? null,
      input.runId ?? null,
      input.idempotencyKey ?? null,
    ],
  );
  if (rowCount === 0) return null;
  return getMessage(db, companyId, id);
}

export function getMessage(db: Db, companyId: string, messageId: string): Promise<RoomMessage | null> {
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "room_messages")} WHERE company_id = $1 AND id = $2`,
    [companyId, messageId],
    mapMessage,
  );
}

export function getMessageByIdempotencyKey(
  db: Db,
  companyId: string,
  roomId: string,
  idempotencyKey: string,
): Promise<RoomMessage | null> {
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "room_messages")} WHERE company_id = $1 AND room_id = $2 AND idempotency_key = $3`,
    [companyId, roomId, idempotencyKey],
    mapMessage,
  );
}

/** Every Message of a Room, oldest first. For the transcript use `listMessagesPage`. */
export function listMessages(db: Db, companyId: string, roomId: string): Promise<RoomMessage[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "room_messages")} WHERE company_id = $1 AND room_id = $2 ORDER BY created_at, id`,
    [companyId, roomId],
    mapMessage,
  );
}

export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 200;

export interface MessagePage {
  /** Oldest first, so the newest Message is last. */
  messages: RoomMessage[];
  /**
   * More Messages exist beyond this page in the direction it travelled: older ones for the latest
   * page and for `before`, newer ones for `after`.
   */
  hasMore: boolean;
}

/**
 * One page of a Room's transcript in a stable order (`created_at`, then `id`). The page is always
 * returned oldest first.
 *
 * - No cursor: the latest `limit` Messages.
 * - `before`: the `limit` Messages immediately older than that Message (older pages, no overlap).
 * - `after`: the `limit` Messages immediately newer than that Message (live catch-up).
 *
 * The cursor Message must be in this Room (the caller checks with `getMessage`); an unknown cursor
 * gives an empty page. Ticket 06 builds the Turn prompt from `listMessagesPage(db, c, r, { limit })`.
 */
export async function listMessagesPage(
  db: Db,
  companyId: string,
  roomId: string,
  options: { limit?: number; before?: string; after?: string } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE), 1), MAX_MESSAGE_PAGE_SIZE);
  const messages = table(db, "room_messages");
  const cursor = options.before ?? options.after ?? null;
  // Each `$n` occurrence is bound separately by the host, so a repeated value gets its own number.
  const params: unknown[] = [companyId, roomId];
  let cursorClause = "";
  if (cursor !== null) {
    params.push(companyId, roomId, cursor);
    const op = options.before !== undefined ? "<" : ">";
    cursorClause = `AND (created_at, id) ${op} (SELECT c.created_at, c.id FROM ${messages} c WHERE c.company_id = $3 AND c.room_id = $4 AND c.id = $5)`;
  }
  const newestFirst = options.after === undefined;
  params.push(limit + 1);
  const rows = await selectMany(
    db,
    `SELECT * FROM ${messages}
     WHERE company_id = $1 AND room_id = $2 ${cursorClause}
     ORDER BY created_at ${newestFirst ? "DESC" : "ASC"}, id ${newestFirst ? "DESC" : "ASC"}
     LIMIT $${params.length}`,
    params,
    mapMessage,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (newestFirst) page.reverse();
  return { messages: page, hasMore };
}
