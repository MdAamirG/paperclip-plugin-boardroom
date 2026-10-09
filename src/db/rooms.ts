import { randomUUID } from "node:crypto";
import { type Db, type Row, num, selectMany, selectOne, str, strOrNull, table } from "./sql.js";

export const ROOM_STATUSES = ["open", "closed"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const DEFAULT_MAX_TOTAL_TURNS = 40;
export const MIN_MAX_TOTAL_TURNS = 1;
export const MAX_MAX_TOTAL_TURNS = 200;

export interface Room {
  id: string;
  companyId: string;
  title: string;
  topic: string;
  projectId: string | null;
  ownerUserId: string;
  status: RoomStatus;
  maxTotalTurns: number;
  decisionMd: string | null;
  decisionByUserId: string | null;
  decisionAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export function mapRoom(row: Row): Room {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    title: str(row.title),
    topic: str(row.topic),
    projectId: strOrNull(row.project_id),
    ownerUserId: str(row.owner_user_id),
    status: str(row.status) as RoomStatus,
    maxTotalTurns: num(row.max_total_turns),
    decisionMd: strOrNull(row.decision_md),
    decisionByUserId: strOrNull(row.decision_by_user_id),
    decisionAt: strOrNull(row.decision_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    closedAt: strOrNull(row.closed_at),
  };
}

export interface NewRoom {
  title: string;
  topic: string;
  ownerUserId: string;
  projectId?: string | null;
  /** 1 to 200; the column default (40) when omitted. The check constraint rejects anything else. */
  maxTotalTurns?: number;
}

export async function insertRoom(db: Db, companyId: string, input: NewRoom): Promise<Room> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ${table(db, "rooms")} (id, company_id, title, topic, owner_user_id, project_id, max_total_turns)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, input.title, input.topic, input.ownerUserId, input.projectId ?? null, input.maxTotalTurns ?? DEFAULT_MAX_TOTAL_TURNS],
  );
  const room = await getRoom(db, companyId, id);
  if (!room) throw new Error(`Room ${id} was not readable after insert`);
  return room;
}

export function getRoom(db: Db, companyId: string, roomId: string): Promise<Room | null> {
  return selectOne(db, `SELECT * FROM ${table(db, "rooms")} WHERE company_id = $1 AND id = $2`, [companyId, roomId], mapRoom);
}

/** The company's Rooms, most recently updated first. */
export function listRooms(db: Db, companyId: string): Promise<Room[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "rooms")} WHERE company_id = $1 ORDER BY updated_at DESC, id`,
    [companyId],
    mapRoom,
  );
}

export interface RoomSummary extends Room {
  /** Active Participants only. */
  participantCount: number;
  /** The later of the Room's last update and its latest Message. */
  lastActivityAt: string;
}

/** The company's Rooms with Participant count and last activity, newest activity first. */
export function listRoomSummaries(db: Db, companyId: string): Promise<RoomSummary[]> {
  return selectMany(
    db,
    `SELECT r.*,
            (SELECT count(*)::int FROM ${table(db, "room_participants")} p
              WHERE p.company_id = r.company_id AND p.room_id = r.id AND p.removed_at IS NULL) AS participant_count,
            GREATEST(r.updated_at,
              coalesce((SELECT max(m.created_at) FROM ${table(db, "room_messages")} m
                         WHERE m.company_id = r.company_id AND m.room_id = r.id), r.updated_at)) AS last_activity_at
     FROM ${table(db, "rooms")} r
     WHERE r.company_id = $1
     ORDER BY last_activity_at DESC, r.id`,
    [companyId],
    (row) => ({ ...mapRoom(row), participantCount: num(row.participant_count), lastActivityAt: str(row.last_activity_at) }),
  );
}

/**
 * Remove a Room and, by cascade, everything under it. Only for rolling back a Room whose creation
 * failed half way; users never delete Rooms.
 */
export async function deleteRoom(db: Db, companyId: string, roomId: string): Promise<boolean> {
  const { rowCount } = await db.execute(`DELETE FROM ${table(db, "rooms")} WHERE company_id = $1 AND id = $2`, [
    companyId,
    roomId,
  ]);
  return rowCount > 0;
}
