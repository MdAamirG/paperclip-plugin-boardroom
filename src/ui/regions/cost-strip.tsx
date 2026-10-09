import { Spinner } from "@paperclipai/plugin-sdk/ui";
import type { AgentCost, RoomCostsResponse } from "../../api/types.js";
import { useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { capState, formatSpend, formatTokens, type CapState } from "../cost-format.js";
import { useAsyncResource } from "../hooks.js";
import { shortId } from "../format.js";
import { RegionFrame, type RegionProps } from "./frame.js";

const CAP_TEXT: Record<CapState, string | null> = {
  ok: null,
  warning: "Warning: 80% or more of the turn cap is used. Rounds stop at the cap.",
  reached: "Cap reached: a new Round needs a higher turn cap.",
};

/** The cost strip: total spend, tokens, runs and Turns used against the cap, then the per-agent panel. Refetches on `room.changed`. */
export function CostStripRegion({ companyId, detail, refreshKey }: RegionProps) {
  const roomId = detail.room.id;
  const client = useBoardroomClient(companyId);
  const costs = useAsyncResource(() => client.getCosts(roomId), [client, roomId], refreshKey);
  return (
    <RegionFrame region="cost" title="Cost">
      {costs.loading ? (
        <p className="br-row" aria-live="polite">
          <Spinner size="sm" label="Loading cost" />
          <span className="br-muted">Loading cost…</span>
        </p>
      ) : costs.data ? (
        <>
          {costs.error ? <ErrorNotice title="Could not refresh the cost" error={costs.error} onRetry={costs.reload} /> : null}
          <CostStrip costs={costs.data} />
          <AgentCostPanel agents={costs.data.agents} />
        </>
      ) : (
        <ErrorNotice title="Could not load the cost" error={costs.error ?? new Error("The cost did not load.")} onRetry={costs.reload} />
      )}
    </RegionFrame>
  );
}

function CostStrip({ costs }: { costs: RoomCostsResponse }) {
  const state = capState(costs.turnsUsed, costs.maxTotalTurns);
  const message = CAP_TEXT[state];
  return (
    <div className="br-stack" data-testid="cost-strip" data-cap-state={state}>
      <dl className="br-meta">
        <dt>Spend</dt>
        <dd data-cost-field="spend">{formatSpend(costs.costCents, costs.subscriptionBilled)}</dd>
        <dt>Tokens</dt>
        <dd data-cost-field="tokens">{formatTokens(costs)}</dd>
        <dt>Runs</dt>
        <dd data-cost-field="runs">{costs.runCount}</dd>
        <dt>Turns used</dt>
        <dd data-cost-field="turns">
          {costs.turnsUsed} / {costs.maxTotalTurns}
        </dd>
      </dl>
      {message ? (
        <p className={state === "reached" ? "br-notice br-notice-error" : "br-notice br-notice-warn"} role="status" data-testid="cap-notice">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function AgentCostPanel({ agents }: { agents: AgentCost[] }) {
  if (agents.length === 0) return <p className="br-muted">No Turns have run in this Room yet.</p>;
  return (
    <div className="br-table-wrap">
      <table className="br-table" aria-label="Cost per agent">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col" className="br-num">
              Spend
            </th>
            <th scope="col">Tokens</th>
            <th scope="col">Turns</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.agentId} data-agent-id={agent.agentId} data-active-participant={agent.isActiveParticipant ? "true" : "false"}>
              <td>
                {agent.agentName ?? `Removed agent (${shortId(agent.agentId)})`}
                {agent.isActiveParticipant ? null : <span className="br-muted br-small"> (no longer in this Room)</span>}
              </td>
              <td className="br-num">{formatSpend(agent.costCents, agent.subscriptionBilled)}</td>
              <td className="br-small">{formatTokens(agent)}</td>
              <td className="br-small">
                {agent.outcomes.posted} replied · {agent.outcomes.silent} silent · {agent.outcomes.failed} failed · {agent.outcomes.skipped} skipped
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
