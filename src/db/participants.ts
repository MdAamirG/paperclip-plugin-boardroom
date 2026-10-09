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
  /** Join order within the Room, from 0. Removed rows keep theirs. Order by this, never by `addedAt`. */
  position: number;
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
    position: num(row.position),
    addedAt: str(row.added_at),
    removedAt: strOrNull(row.removed_at),
  };
}

/**
 * Add an active Participant at the next free position (largest position in the Room, removed rows
 * included, plus one). Returns `null` when the agent is already an active Participant of the
 * Room. Throws when the Room is not in the company (foreign key on `(company_id, room_id)`), or
 * when a concurrent add took the same position (unique `(room_id, position)`); the caller may retry.
 */
export async function insertParticipant(
  db: Db,
  companyId: string,
  input: { roomId: string; agentId: string; addedByUserId: string },
): Promise<RoomParticipant | null> {
  const id = randomUUID();
  const participants = table(db, "room_participants");
  const { rowCount } = await db.execute(
    `INSERT INTO ${participants} (id, company_id, room_id, agent_id, added_by_user_id, position)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, coalesce(max(p.position), -1) + 1
     FROM ${participants} p
     WHERE p.company_id = $6 AND p.room_id = $7
     ON CONFLICT (room_id, agent_id) WHERE removed_at IS NULL DO NOTHING`,
    [id, companyId, input.roomId, input.agentId, input.addedByUserId, companyId, input.roomId],
  );
  if (rowCount === 0) return null;
  return selectOne(db, `SELECT * FROM ${participants} WHERE company_id = $1 AND id = $2`, [companyId, id], mapParticipant);
}

/**
 * Add several Participants to a Room that has none yet, in ONE statement, so the whole set is
 * written or none of it is. Positions are the order of `agentIds`, from 0. Duplicate agents, or a
 * Room that already has Participants, make the statement fail as a whole. Returns the row count.
 */
export async function insertInitialParticipants(
  db: Db,
  companyId: string,
  input: { roomId: string; agentIds: string[]; addedByUserId: string },
): Promise<number> {
  if (input.agentIds.length === 0) return 0;
  const params: unknown[] = [];
  const rows = input.agentIds.map((agentId, position) => {
    params.push(companyId, input.roomId, agentId, input.addedByUserId);
    const at = params.length - 3;
    return `($${at}, $${at + 1}, $${at + 2}, $${at + 3}, ${position})`;
  });
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "room_participants")} (company_id, room_id, agent_id, added_by_user_id, position)
     VALUES ${rows.join(", ")}`,
    params,
  );
  return rowCount;
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

/** Active Participants in join order (`position`). */
export function listActiveParticipants(db: Db, companyId: string, roomId: string): Promise<RoomParticipant[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "room_participants")}
     WHERE company_id = $1 AND room_id = $2 AND removed_at IS NULL
     ORDER BY position`,
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
