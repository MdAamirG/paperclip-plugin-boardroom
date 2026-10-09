import { type Db, type Row, num, selectMany, str, strOrNull, table } from "./sql.js";

/** What one Turn's run cost, summed over its `public.cost_events` rows (all zero when it has none). */
export interface TurnCostRow {
  turnId: string;
  agentId: string;
  /** `posted`, `silent`, `failed`, `skipped`, or null while the Turn has not finished. */
  outcome: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Number of cost events found for the Turn's run. */
  events: number;
  /** Events that are subscription billed with zero cents. Billing is "subscription only" when this equals `events` and `events > 0`. */
  subscriptionEvents: number;
}

/**
 * Every Turn of the Room with its cost, in one SELECT: the Room's Turns (through their Rounds)
 * left-joined to `public.cost_events` on the run id, company-filtered on both sides.
 * `billing_type` values `subscription_included` and `subscription_overage` both count as subscription.
 */
export function listTurnCosts(db: Db, companyId: string, roomId: string): Promise<TurnCostRow[]> {
  return selectMany(
    db,
    `SELECT t.id AS turn_id, t.agent_id, t.outcome,
            COALESCE(SUM(c.cost_cents), 0)::bigint AS cost_cents,
            COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(SUM(c.cached_input_tokens), 0)::bigint AS cached_input_tokens,
            COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
            COUNT(c.id)::int AS events,
            (COUNT(c.id) FILTER (WHERE c.billing_type LIKE 'subscription%' AND c.cost_cents = 0))::int AS subscription_events
       FROM ${table(db, "turns")} t
       JOIN ${table(db, "rounds")} r ON r.company_id = t.company_id AND r.id = t.round_id
       LEFT JOIN public.cost_events c ON c.company_id = t.company_id AND c.heartbeat_run_id = t.run_id
      WHERE t.company_id = $1 AND r.room_id = $2
      GROUP BY t.id, t.agent_id, t.outcome, r.seq, t.ord
      ORDER BY r.seq, t.ord`,
    [companyId, roomId],
    (row: Row): TurnCostRow => ({
      turnId: str(row.turn_id),
      agentId: str(row.agent_id),
      outcome: strOrNull(row.outcome),
      costCents: num(row.cost_cents),
      inputTokens: num(row.input_tokens),
      cachedInputTokens: num(row.cached_input_tokens),
      outputTokens: num(row.output_tokens),
      events: num(row.events),
      subscriptionEvents: num(row.subscription_events),
    }),
  );
}
