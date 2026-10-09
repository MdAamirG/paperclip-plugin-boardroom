import { randomUUID } from "node:crypto";
import { type Db, type Row, num, selectMany, selectOne, str, strOrNull, table } from "./sql.js";

/** Enforced by the route layer (a count does not fit a constraint); see `countActiveParticipants`. */
export const MAX_ACTIVE_PARTICIPANTS = 8;

export interface RoomParticipant {
  id: string;
  companyId: string;
  roomId: string;
  agentId: string;
  addedByUserId: string;
  addedAt: string;
  removedAt: string | null;
}

export function mapParticipant(row: Row): RoomParticipant {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    roomId: str(row.room_id),
    agentId: str(row.agent_id),
    addedByUserId: str(row.added_by_user_id),
    addedAt: str(row.added_at),
    removedAt: strOrNull(row.removed_at),
  };
}

/**
 * Add an active Participant. Returns `null` when the agent is already an active Participant of
 * the Room. Throws when the Room is not in the company (foreign key on `(company_id, room_id)`).
 */
export async function insertParticipant(
  db: Db,
  companyId: string,
  input: { roomId: string; agentId: string; addedByUserId: string },
): Promise<RoomParticipant | null> {
  const id = randomUUID();
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "room_participants")} (id, company_id, room_id, agent_id, added_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (room_id, agent_id) WHERE removed_at IS NULL DO NOTHING`,
    [id, companyId, input.roomId, input.agentId, input.addedByUserId],
  );
  if (rowCount === 0) return null;
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "room_participants")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
    mapParticipant,
  );
}

/** Soft-remove the agent's active row. Returns false when there was none. */
export async function removeParticipant(db: Db, companyId: string, roomId: string, agentId: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "room_participants")} SET removed_at = now()
     WHERE company_id = $1 AND room_id = $2 AND agent_id = $3 AND removed_at IS NULL`,
    [companyId, roomId, agentId],
  );
  return rowCount > 0;
}

/** Active Participants in join order (`added_at`). */
export function listActiveParticipants(db: Db, companyId: string, roomId: string): Promise<RoomParticipant[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "room_participants")}
     WHERE company_id = $1 AND room_id = $2 AND removed_at IS NULL
     ORDER BY added_at, id`,
    [companyId, roomId],
    mapParticipant,
  );
}

export async function countActiveParticipants(db: Db, companyId: string, roomId: string): Promise<number> {
  const rows = await db.query<Row>(
    `SELECT count(*)::int AS n FROM ${table(db, "room_participants")}
     WHERE company_id = $1 AND room_id = $2 AND removed_at IS NULL`,
    [companyId, roomId],
  );
  return num(rows[0]?.n ?? 0);
}
