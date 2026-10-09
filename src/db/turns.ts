import { randomUUID } from "node:crypto";
import { type Db, type Row, num, selectMany, selectOne, str, strOrNull, table } from "./sql.js";

export type TurnStatus = "queued" | "running" | "finished";
export type TurnOutcome = "posted" | "silent" | "failed" | "skipped";
export type TurnSkipReason = "not_invokable" | "stopped";

export interface Turn {
  id: string;
  companyId: string;
  roundId: string;
  agentId: string;
  /** 1-based order within the Round. */
  ord: number;
  status: TurnStatus;
  /** Set exactly when `status` is `finished`. */
  outcome: TurnOutcome | null;
  /** Set exactly when `outcome` is `skipped`. */
  skipReason: TurnSkipReason | null;
  /** The host's message, word for word (for a rejected send). */
  hostMessage: string | null;
  sessionId: string | null;
  runId: string | null;
  messageId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function mapTurn(row: Row): Turn {
  return {
    id: str(row.id),
    companyId: str(row.company_id),
    roundId: str(row.round_id),
    agentId: str(row.agent_id),
    ord: num(row.ord),
    status: str(row.status) as TurnStatus,
    outcome: strOrNull(row.outcome) as TurnOutcome | null,
    skipReason: strOrNull(row.skip_reason) as TurnSkipReason | null,
    hostMessage: strOrNull(row.host_message),
    sessionId: strOrNull(row.session_id),
    runId: strOrNull(row.run_id),
    messageId: strOrNull(row.message_id),
    createdAt: str(row.created_at),
    startedAt: strOrNull(row.started_at),
    finishedAt: strOrNull(row.finished_at),
  };
}

/**
 * Queue a Turn. Returns `null` when the agent already has a Turn in this Round (the
 * (Round, agent) guard). Throws on a repeated `ord` or a Round outside the company.
 */
export async function insertTurn(
  db: Db,
  companyId: string,
  input: { roundId: string; agentId: string; ord: number },
): Promise<Turn | null> {
  const id = randomUUID();
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db, "turns")} (id, company_id, round_id, agent_id, ord)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (round_id, agent_id) DO NOTHING`,
    [id, companyId, input.roundId, input.agentId, input.ord],
  );
  if (rowCount === 0) return null;
  return getTurn(db, companyId, id);
}

export function getTurn(db: Db, companyId: string, turnId: string): Promise<Turn | null> {
  return selectOne(db, `SELECT * FROM ${table(db, "turns")} WHERE company_id = $1 AND id = $2`, [companyId, turnId], mapTurn);
}

/** The Round's Turns in order. */
export function listTurns(db: Db, companyId: string, roundId: string): Promise<Turn[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "turns")} WHERE company_id = $1 AND round_id = $2 ORDER BY ord`,
    [companyId, roundId],
    mapTurn,
  );
}

/** The Turn whose run this is (run events and the sweep). */
export function findTurnByRunId(db: Db, companyId: string, runId: string): Promise<Turn | null> {
  return selectOne(
    db,
    `SELECT * FROM ${table(db, "turns")} WHERE company_id = $1 AND run_id = $2`,
    [companyId, runId],
    mapTurn,
  );
}
