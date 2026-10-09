import { useId, useState } from "react";
import type { ParticipantView } from "../../api/types.js";
import { listCompanyAgents, useBoardroomApi, useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { shortId } from "../format.js";
import { toError, useAsyncResource } from "../hooks.js";
import { MAX_PARTICIPANTS } from "../limits.js";
import { RegionFrame, type RegionProps } from "./frame.js";

/**
 * The active Participants in join order. With `control` on an open Room, the Owner can remove a
 * Participant and add an agent; both are disabled, with the reason shown, while a Round is active
 * (membership never changes during a Round). A closed Room, and anyone without `control`, sees the list only.
 */
export function ParticipantsRegion({ companyId, detail, reloadRoom }: RegionProps) {
  const client = useBoardroomClient(companyId);
  const canEdit = detail.permissions.canControl && detail.room.status === "open";
  const roundActive = detail.activeRound !== null;
  const locked = roundActive;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The answer to our own edit shows at once; the refetch that follows replaces it.
  const [saved, setSaved] = useState<typeof detail | null>(null);
  const current = saved && saved.room.updatedAt >= detail.room.updatedAt ? saved : detail;
  const participants = current.participants;
  const atLimit = participants.length >= MAX_PARTICIPANTS;

  async function run(action: () => Promise<typeof detail>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSaved(await action());
      reloadRoom();
    } catch (failure) {
      setError(toError(failure));
      // A Round started or the Room closed in the meantime: refetch so the panel matches.
      if (["round_active", "room_closed"].includes(String((failure as { code?: unknown }).code))) reloadRoom();
    } finally {
      setBusy(false);
    }
  }

  return (
    <RegionFrame region="participants" title="Participants">
      {participants.length === 0 ? (
        <p className="br-muted">No active Participants.</p>
      ) : (
        <ul className="br-participants">
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.id}
              participant={participant}
              onRemove={canEdit ? () => void run(() => client.removeParticipant(detail.room.id, participant.agentId)) : null}
              disabled={locked || busy}
            />
          ))}
        </ul>
      )}
      {canEdit ? (
        <>
          {roundActive ? (
            <p className="br-muted br-small" role="status">
              A Round is in progress, so Participants cannot be added or removed. Stop it or wait for it to finish.
            </p>
          ) : null}
          <AddParticipant
            companyId={companyId}
            activeAgentIds={participants.map((p) => p.agentId)}
            atLimit={atLimit}
            disabled={locked || busy}
            onAdd={(agentId) => void run(() => client.addParticipant(detail.room.id, agentId))}
          />
          {error ? <ErrorNotice title="Could not change the Participants" error={error} /> : null}
        </>
      ) : null}
    </RegionFrame>
  );
}

function AddParticipant({
  companyId,
  activeAgentIds,
  atLimit,
  disabled,
  onAdd,
}: {
  companyId: string;
  activeAgentIds: string[];
  atLimit: boolean;
  disabled: boolean;
  onAdd: (agentId: string) => void;
}) {
  const api = useBoardroomApi();
  const selectId = useId();
  const [choice, setChoice] = useState("");
  const agents = useAsyncResource(async () => {
    const all = await listCompanyAgents(api, companyId);
    // A terminated agent can never take a Turn, so it is not offered.
    return all.filter((agent) => agent.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name));
  }, [api, companyId]);

  const eligible = (agents.data ?? []).filter((agent) => !activeAgentIds.includes(agent.id));
  const picked = eligible.some((agent) => agent.id === choice) ? choice : "";

  if (agents.error) return <ErrorNotice title="Could not load the company's agents" error={agents.error} onRetry={agents.reload} />;
  return (
    <div className="br-stack">
      <div className="br-field">
        <label className="br-label" htmlFor={selectId}>
          Add an agent
        </label>
        <div className="br-row">
          <select
            id={selectId}
            className="br-input br-grow"
            value={picked}
            onChange={(event) => setChoice(event.target.value)}
            disabled={disabled || atLimit || agents.loading}
          >
            <option value="">{agents.loading ? "Loading agents…" : eligible.length === 0 ? "No other agents to add" : "Pick an agent"}</option>
            {eligible.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.role ? ` (${agent.role})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="br-btn br-btn-primary"
            disabled={disabled || atLimit || picked === ""}
            onClick={() => {
              onAdd(picked);
              setChoice("");
            }}
          >
            Add
          </button>
        </div>
      </div>
      {atLimit ? (
        <p className="br-error-text br-small" role="status">
          A Room holds at most {MAX_PARTICIPANTS} agents. Remove one to add another.
        </p>
      ) : null}
    </div>
  );
}

function ParticipantRow({ participant, onRemove, disabled }: { participant: ParticipantView; onRemove: (() => void) | null; disabled: boolean }) {
  const detailText = [participant.role, participant.title].filter(Boolean).join(" · ");
  const label = participant.name ?? `Removed agent (${shortId(participant.agentId)})`;
  return (
    <li>
      <span className="br-row">
        <span className="br-grow">{label}</span>
        {onRemove ? (
          <button type="button" className="br-btn" onClick={onRemove} disabled={disabled} aria-label={`Remove ${label}`}>
            Remove
          </button>
        ) : null}
      </span>
      {detailText ? <span className="br-muted br-small">{detailText}</span> : null}
    </li>
  );
}
