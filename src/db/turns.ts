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

/** Every Turn of the Room's Rounds, by Round then order (the Round history). */
export function listTurnsForRoom(db: Db, companyId: string, roomId: string): Promise<Turn[]> {
  return selectMany(
    db,
    `SELECT t.* FROM ${table(db, "turns")} t
       JOIN ${table(db, "rounds")} r ON r.company_id = t.company_id AND r.id = t.round_id
      WHERE t.company_id = $1 AND r.room_id = $2
      ORDER BY r.seq, t.ord`,
    [companyId, roomId],
    mapTurn,
  );
}

/**
 * Turns that count against the Room's turn cap: every Turn of the Room except those skipped
 * before their run started (a skipped Turn never starts one).
 */
export async function countCountedTurns(db: Db, companyId: string, roomId: string): Promise<number> {
  const rows = await db.query<Row>(
    `SELECT count(*)::int AS n FROM ${table(db, "turns")} t
       JOIN ${table(db, "rounds")} r ON r.company_id = t.company_id AND r.id = t.round_id
      WHERE t.company_id = $1 AND r.room_id = $2 AND t.outcome IS DISTINCT FROM 'skipped'`,
    [companyId, roomId],
  );
  return num(rows[0]?.n ?? 0);
}

/**
 * Start the Round's next queued Turn (lowest `ord`): it becomes `running` with `started_at` set.
 * One statement, and it applies only while the Round is `running` and none of its Turns is
 * running, so two callers racing cannot start two Turns. Returns the started Turn, or `null`
 * when nothing was started (a Turn is running, the Round is not running, or none is queued).
 */
export async function startNextTurn(db: Db, companyId: string, roundId: string): Promise<Turn | null> {
  const turns = table(db, "turns");
  const { rowCount } = await db.execute(
    `UPDATE ${turns} SET status = 'running', started_at = now()
      WHERE company_id = $1 AND status = 'queued'
        AND id = (SELECT q.id FROM ${turns} q WHERE q.company_id = $2 AND q.round_id = $3 AND q.status = 'queued' ORDER BY q.ord LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM ${turns} x WHERE x.company_id = $4 AND x.round_id = $5 AND x.status = 'running')
        AND EXISTS (SELECT 1 FROM ${table(db, "rounds")} r WHERE r.company_id = $6 AND r.id = $7 AND r.status = 'running')`,
    [companyId, companyId, roundId, companyId, roundId, companyId, roundId],
  );
  if (rowCount === 0) return null;
  return selectOne(
    db,
    `SELECT * FROM ${turns} WHERE company_id = $1 AND round_id = $2 AND status = 'running'`,
    [companyId, roundId],
    mapTurn,
  );
}

/** How many Turns of the Round have not finished (queued or running). */
export async function countUnfinishedTurns(db: Db, companyId: string, roundId: string): Promise<number> {
  const rows = await db.query<Row>(
    `SELECT count(*)::int AS n FROM ${table(db, "turns")} WHERE company_id = $1 AND round_id = $2 AND status <> 'finished'`,
    [companyId, roundId],
  );
  return num(rows[0]?.n ?? 0);
}

/** Remember the session a running Turn uses. */
export async function setTurnSession(db: Db, companyId: string, turnId: string, sessionId: string): Promise<boolean> {
  const { rowCount } = await db.execute(`UPDATE ${table(db, "turns")} SET session_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    turnId,
    sessionId,
  ]);
  return rowCount > 0;
}

/** Remember the run the host started for a Turn. Never overwrites a run id that is already set. */
export async function setTurnRunId(db: Db, companyId: string, turnId: string, runId: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "turns")} SET run_id = $3::uuid WHERE company_id = $1 AND id = $2 AND run_id IS NULL`,
    [companyId, turnId, runId],
  );
  return rowCount > 0;
}

/**
 * Settle a Turn: `running` becomes `finished` with the outcome. This is the settle-once guard
 * (`WHERE status = 'running'`): it returns true for the one caller that finished the Turn and false
 * for every later signal. A run id is stored only if the Turn has none yet.
 */
export async function finishRunningTurn(
  db: Db,
  companyId: string,
  turnId: string,
  result: { outcome: Exclude<TurnOutcome, "skipped">; runId?: string | null; hostMessage?: string | null },
): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "turns")}
        SET status = 'finished', outcome = $3, finished_at = now(),
            run_id = COALESCE(run_id, $4::uuid), host_message = $5::text
      WHERE company_id = $1 AND id = $2 AND status = 'running'`,
    [companyId, turnId, result.outcome, result.runId ?? null, result.hostMessage ?? null],
  );
  return rowCount > 0;
}

/** Point a Turn at the Message it posted. */
export async function setTurnMessage(db: Db, companyId: string, turnId: string, messageId: string): Promise<boolean> {
  const { rowCount } = await db.execute(`UPDATE ${table(db, "turns")} SET message_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    turnId,
    messageId,
  ]);
  return rowCount > 0;
}

/** A finished Turn whose reply could not be saved becomes `failed` (the host message says why). */
export async function markPostedTurnFailed(db: Db, companyId: string, turnId: string, hostMessage: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "turns")} SET outcome = 'failed', host_message = $3
      WHERE company_id = $1 AND id = $2 AND status = 'finished' AND outcome = 'posted' AND message_id IS NULL`,
    [companyId, turnId, hostMessage],
  );
  return rowCount > 0;
}

/**
 * A running Turn whose send the host refused becomes `finished`/`skipped` with the host's message
 * word for word. Settle-once like `finishRunningTurn` (`WHERE status = 'running'`).
 */
export async function skipRunningTurn(
  db: Db,
  companyId: string,
  turnId: string,
  skip: { reason: "not_invokable" | "stopped"; hostMessage?: string | null },
): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${table(db, "turns")}
        SET status = 'finished', outcome = 'skipped', skip_reason = $3, host_message = $4::text, finished_at = now()
      WHERE company_id = $1 AND id = $2 AND status = 'running'`,
    [companyId, turnId, skip.reason, skip.hostMessage ?? null],
  );
  return rowCount > 0;
}
