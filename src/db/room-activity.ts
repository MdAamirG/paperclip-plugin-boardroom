import { type Db, type Row, str, table } from "./sql.js";

/**
 * Mark a Room as just used. `rooms.updated_at` is never bumped by the database (no trigger), so
 * every mutation that should move the Room up the list calls this. Returns false when the Room is
 * not in the company.
 */
export async function touchRoom(db: Db, companyId: string, roomId: string): Promise<boolean> {
  const { rowCount } = await db.execute(`UPDATE ${table(db, "rooms")} SET updated_at = now() WHERE company_id = $1 AND id = $2`, [
    companyId,
    roomId,
  ]);
  return rowCount > 0;
}

export interface ParticipantAgentIds {
  /** Agents that are active Participants now. */
  active: Set<string>;
  /** Agents that were Participants and have been removed (and are not active now). */
  removed: Set<string>;
}

/** Which agents are, or were, Participants of the Room. Ids are lower case, as Postgres prints uuids. */
export async function listParticipantAgentIds(db: Db, companyId: string, roomId: string): Promise<ParticipantAgentIds> {
  const rows = await db.query<Row>(
    `SELECT agent_id, (removed_at IS NULL) AS is_active FROM ${table(db, "room_participants")}
     WHERE company_id = $1 AND room_id = $2`,
    [companyId, roomId],
  );
  const result: ParticipantAgentIds = { active: new Set(), removed: new Set() };
  for (const row of rows) {
    const agentId = str(row.agent_id).toLowerCase();
    if (row.is_active === true || row.is_active === "t" || row.is_active === "true") result.active.add(agentId);
    else result.removed.add(agentId);
  }
  for (const id of result.active) result.removed.delete(id);
  return result;
}
