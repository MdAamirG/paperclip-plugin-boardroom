import { type Db, type Row, selectMany, selectOne, str, strOrNull, table } from "./sql.js";
import { mapRound, type Round } from "./rounds.js";
import { mapTurn, type Turn } from "./turns.js";

/** Host run statuses (`heartbeat_runs.status`) that can still change. Anything else is terminal. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "scheduled_retry", "running"]);

export interface RunSnapshot {
  id: string;
  status: string;
  /** `result_json -> 'summary'`, the agent's final reply text (null when absent). */
  summary: string | null;
  error: string | null;
}

export const isRunTerminal = (status: string): boolean => !ACTIVE_RUN_STATUSES.has(status);

/** Read one run from the host's `public.heartbeat_runs` (a declared core read table), by run id and company. */
export function getRunSnapshot(db: Db, companyId: string, runId: string): Promise<RunSnapshot | null> {
  return selectOne(
    db,
    `SELECT id, status, result_json ->> 'summary' AS summary, error
       FROM public.heartbeat_runs WHERE company_id = $1 AND id = $2`,
    [companyId, runId],
    (row: Row) => ({ id: str(row.id), status: str(row.status), summary: strOrNull(row.summary), error: strOrNull(row.error) }),
  );
}

/**
 * Companies that have something the sweep may need to act on. This is the one query without a
 * company filter: it only discovers which companies to visit; every later query filters by company.
 */
export async function listCompaniesWithUnsettledRows(db: Db): Promise<string[]> {
  const rows = await db.query<Row>(
    `SELECT company_id FROM ${table(db, "turns")} WHERE status = 'running' OR (status = 'finished' AND outcome = 'posted' AND message_id IS NULL)
     UNION
     SELECT company_id FROM ${table(db, "rounds")} WHERE status = 'running'`,
  );
  return rows.map((row) => str(row.company_id));
}

/** The company's `running` Turns, oldest first. */
export function listRunningTurns(db: Db, companyId: string): Promise<Turn[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "turns")} WHERE company_id = $1 AND status = 'running' ORDER BY started_at, id`,
    [companyId],
    mapTurn,
  );
}

/** `running` Rounds with no `running` Turn: nothing in flight, so the sweep advances them. */
export function listIdleRunningRounds(db: Db, companyId: string): Promise<Round[]> {
  return selectMany(
    db,
    `SELECT id, company_id, room_id, seq, started_by_user_id, trigger_message_id, ask_all,
            array_to_json(addressed_agent_ids) AS addressed_agent_ids, status, created_at, updated_at, ended_at
       FROM ${table(db, "rounds")} r
      WHERE r.company_id = $1 AND r.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM ${table(db, "turns")} t WHERE t.company_id = $1 AND t.round_id = r.id AND t.status = 'running')
      ORDER BY r.created_at, r.id`,
    [companyId],
    mapRound,
  );
}

/**
 * Turns marked `posted` whose Message link is missing for longer than `graceSeconds`: the worker
 * died between settling the Turn and saving its Message. The grace period keeps the sweep away
 * from a live settlement that is still saving.
 */
export function listPostedTurnsWithoutMessage(db: Db, companyId: string, graceSeconds: number): Promise<Turn[]> {
  return selectMany(
    db,
    `SELECT * FROM ${table(db, "turns")}
      WHERE company_id = $1 AND status = 'finished' AND outcome = 'posted' AND message_id IS NULL
        AND finished_at < now() - $2::int * interval '1 second'
      ORDER BY finished_at, id`,
    [companyId, Math.floor(graceSeconds)],
    mapTurn,
  );
}

/** The Message already saved for a Turn, if any (so a repair never saves a second one). */
export async function getMessageIdForTurn(db: Db, companyId: string, turnId: string): Promise<string | null> {
  const rows = await db.query<Row>(
    `SELECT id FROM ${table(db, "room_messages")} WHERE company_id = $1 AND turn_id = $2 ORDER BY created_at, id LIMIT 1`,
    [companyId, turnId],
  );
  return rows[0] ? str(rows[0].id) : null;
}
