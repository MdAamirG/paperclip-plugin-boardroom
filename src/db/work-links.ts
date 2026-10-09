import { randomUUID } from "node:crypto";
import { type Db, type Row, selectMany, selectOne, str, table } from "./sql.js";

export type WorkLinkRelation = "created" | "linked";

export interface WorkLink {
  id: string;
  companyId: string;
  roomId: string;
  issueId: string;
  relation: WorkLinkRelation;
  byUserId: string;
  createdAt: string;
}

export function mapWorkLink(row: Row): WorkLink {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    roomId: str(row.room_id),
    issueId: str(row.issue_id),
    relation: str(row.relation) as WorkLinkRelation,
    byUserId: str(row.by_user_id),
    createdAt: str(row.created_at),
  };
}

/** Link an issue to a Room. Returns `null` when the issue is already linked to that Room. */
export async function insertWorkLink(
  db: Db,
  companyId: string,
  input: { roomId: string; issueId: string; relation: WorkLinkRelation; byUserId: string },
): Promise<WorkLink | null> {
  const id = randomUUID();
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "work_links")} (id, company_id, room_id, issue_id, relation, by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (room_id, issue_id) DO NOTHING`,
    [id, companyId, input.roomId, input.issueId, input.relation, input.byUserId],
  );
  if (rowCount === 0) return null;
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "work_links")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
    mapWorkLink,
  );
}

/** A Room's follow-up work, oldest first. */
export function listWorkLinks(db: Db, companyId: string, roomId: string): Promise<WorkLink[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "work_links")} WHERE company_id = $1 AND room_id = $2 ORDER BY created_at, id`,
    [companyId, roomId],
    mapWorkLink,
  );
}

/** The issue-to-Room lookup (the "From Room" chip). */
export function listWorkLinksForIssue(db: Db, companyId: string, issueId: string): Promise<WorkLink[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "work_links")} WHERE company_id = $1 AND issue_id = $2 ORDER BY created_at, id`,
    [companyId, issueId],
    mapWorkLink,
  );
}

/** One work link of a Room by issue id, or `null`. */
export function getWorkLink(db: Db, companyId: string, roomId: string, issueId: string): Promise<WorkLink | null> {
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "work_links")} WHERE company_id = $1 AND room_id = $2 AND issue_id = $3`,
    [companyId, roomId, issueId],
    mapWorkLink,
  );
}

/** Delete the link between a Room and an issue (either relation). Returns false when there was none. */
export async function deleteWorkLink(db: Db, companyId: string, roomId: string, issueId: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `DELETE FROM ${table(db, "work_links")} WHERE company_id = $1 AND room_id = $2 AND issue_id = $3`,
    [companyId, roomId, issueId],
  );
  return rowCount > 0;
}

/**
 * `rooms.updated_at` is never bumped by the database, so a mutation that should move the Room up the
 * list sets it itself. Follow-up work changes call this.
 */
export async function bumpRoomUpdatedAt(db: Db, companyId: string, roomId: string): Promise<void> {
  await db.execute(`UPDATE ${table(db, "rooms")} SET updated_at = now() WHERE company_id = $1 AND id = $2`, [
    companyId,
    roomId,
  ]);
}
