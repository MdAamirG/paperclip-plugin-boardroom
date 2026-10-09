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

/** Every Message of a Room, oldest first. Ticket 05 adds paging. */
export function listMessages(db: Db, companyId: string, roomId: string): Promise<RoomMessage[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "room_messages")} WHERE company_id = $1 AND room_id = $2 ORDER BY created_at, id`,
    [companyId, roomId],
    mapMessage,
  );
}
