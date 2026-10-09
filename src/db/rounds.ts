import { randomUUID } from "node:crypto";
import {
  type Db,
  type Row,
  num,
  selectMany,
  selectOne,
  str,
  strOrNull,
  stringArray,
  table,
  uuidArrayFromJson,
} from "./sql.js";

export const ROUND_STATUSES = ["running", "paused", "stopped", "completed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];
export const ACTIVE_ROUND_STATUSES: readonly RoundStatus[] = ["running", "paused"];

export interface Round {
  id: string;
  companyId: string;
  roomId: string;
  seq: number;
  startedByUserId: string;
  triggerMessageId: string;
  askAll: boolean;
  /** In the order addressed. */
  addressedAgentIds: string[];
  status: RoundStatus;
  createdAt: string;
  updatedAt: string;
  /** Set when the Round is stopped or completed. */
  endedAt: string | null;
}

export function mapRound(row: Row): Round {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    roomId: str(row.room_id),
    seq: num(row.seq),
    startedByUserId: str(row.started_by_user_id),
    triggerMessageId: str(row.trigger_message_id),
    askAll: row.ask_all === true,
    addressedAgentIds: stringArray(row.addressed_agent_ids),
    status: str(row.status) as RoundStatus,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    endedAt: strOrNull(row.ended_at),
  };
}

// `uuid[]` is read back as JSON so the driver's array parsing does not matter.
const ROUND_COLUMNS = `id, company_id, room_id, seq, started_by_user_id, trigger_message_id, ask_all,
  array_to_json(addressed_agent_ids) AS addressed_agent_ids, status, created_at, updated_at, ended_at`;

export interface NewRound {
  roomId: string;
  seq: number;
  startedByUserId: string;
  triggerMessageId: string;
  askAll: boolean;
  addressedAgentIds: string[];
}

/**
 * Start a Round (status `running`). Returns `null` when the Room already has a `running` or
 * `paused` Round. Throws on a repeated `seq` (use `nextRoundSeq`).
 */
export async function insertRound(db: Db, companyId: string, input: NewRound): Promise<Round | null> {
  const id = randomUUID();
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "rounds")}
       (id, company_id, room_id, seq, started_by_user_id, trigger_message_id, ask_all, addressed_agent_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${uuidArrayFromJson("$8")}, 'running')
     ON CONFLICT (room_id) WHERE status IN ('running', 'paused') DO NOTHING`,
    [
      id,
      companyId,
      input.roomId,
      input.seq,
      input.startedByUserId,
      input.triggerMessageId,
      input.askAll,
      JSON.stringify(input.addressedAgentIds),
    ],
  );
  if (rowCount === 0) return null;
  return getRound(db, companyId, id);
}

export function getRound(db: Db, companyId: string, roundId: string): Promise<Round | null> {
  return selectOne(
    db,
    `SELECT ${ROUND_COLUMNS} FROM ${table(db, "rounds")} WHERE company_id = $1 AND id = $2`,
    [companyId, roundId],
    mapRound,
  );
}

/** The Room's `running` or `paused` Round, if any. */
export function getActiveRound(db: Db, companyId: string, roomId: string): Promise<Round | null> {
  return selectOne(
    db,
    `SELECT ${ROUND_COLUMNS} FROM ${table(db, "rounds")}
     WHERE company_id = $1 AND room_id = $2 AND status IN ('running', 'paused')`,
    [companyId, roomId],
    mapRound,
  );
}

/** The Room's Rounds by sequence number. */
export function listRounds(db: Db, companyId: string, roomId: string): Promise<Round[]> {
  return selectMany(
    db,
    `SELECT ${ROUND_COLUMNS} FROM ${table(db, "rounds")} WHERE company_id = $1 AND room_id = $2 ORDER BY seq`,
    [companyId, roomId],
    mapRound,
  );
}

export async function nextRoundSeq(db: Db, companyId: string, roomId: string): Promise<number> {
  const rows = await db.query<Row>(
    `SELECT coalesce(max(seq), 0)::int + 1 AS next FROM ${table(db, "rounds")} WHERE company_id = $1 AND room_id = $2`,
    [companyId, roomId],
  );
  return num(rows[0]?.next ?? 1);
}

/**
 * Set a Round's status; `ended_at` is set for `stopped` and `completed` and cleared otherwise.
 * Returns false when no such Round exists in the company. Does not check transitions: callers do.
 * Setting `running` or `paused` throws if another Round of the Room is already active.
 */
export async function setRoundStatus(db: Db, companyId: string, roundId: string, status: RoundStatus): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "rounds")}
     SET status = $3,
         updated_at = now(),
         ended_at = CASE WHEN $3 IN ('stopped', 'completed') THEN now() ELSE NULL END
     WHERE company_id = $1 AND id = $2`,
    [companyId, roundId, status],
  );
  return rowCount > 0;
}
