import { useId } from "react";
import { MAX_PARTICIPANTS } from "../limits.js";
import type { HostAgent } from "../api.js";

/**
 * Pick 1 to 8 of the company's agents, in speaking order (the order they are ticked). The ninth pick
 * is refused and the reason stays visible.
 */
export function AgentPicker({
  agents,
  selected,
  onChange,
  limit = MAX_PARTICIPANTS,
  invalid,
  describedBy,
}: {
  agents: HostAgent[];
  selected: string[];
  onChange: (agentIds: string[]) => void;
  limit?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  const limitId = useId();
  const atLimit = selected.length >= limit;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  function toggle(agentId: string, checked: boolean) {
    if (!checked) {
      onChange(selected.filter((id) => id !== agentId));
    } else if (!selected.includes(agentId) && selected.length < limit) {
      onChange([...selected, agentId]);
    }
    // At the limit, a tick changes nothing; the message below says why.
  }

  return (
    <fieldset className="br-picked" aria-invalid={invalid ? true : undefined} aria-describedby={[limitId, describedBy].filter(Boolean).join(" ")}>
      <legend className="br-label">Agents</legend>
      <p id={limitId} className={atLimit ? "br-error-text" : "br-muted"} role="status">
        {selected.length} of {limit} selected.
        {atLimit ? ` A Room holds at most ${limit} agents. Remove one to pick another.` : ""}
      </p>
      <ul className="br-pick-list">
        {agents.map((agent) => {
          const checked = selected.includes(agent.id);
          return (
            <li key={agent.id}>
              <label className="br-pick-item">
                <input type="checkbox" checked={checked} onChange={(event) => toggle(agent.id, event.target.checked)} />
                <span>
                  {agent.name} <span className="br-muted">{[agent.role, agent.title].filter(Boolean).join(" · ")}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {selected.length > 0 ? (
        <div>
          <p className="br-muted br-small">Order of the picks:</p>
          <ol className="br-row" aria-label="Picked agents in order">
            {selected.map((agentId, index) => (
              <li key={agentId} className="br-chip">
                <span>
                  {index + 1}. {byId.get(agentId)?.name ?? agentId}
                </span>
                <button type="button" onClick={() => toggle(agentId, false)} aria-label={`Remove ${byId.get(agentId)?.name ?? agentId}`}>
                  ×
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </fieldset>
  );
}
