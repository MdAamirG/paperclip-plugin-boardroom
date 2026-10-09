import { useState } from "react";
import type { RoundView } from "../../api/types.js";
import { cancelHostRun, useBoardroomApi, useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { TurnCost } from "../components/TurnCost.js";
import { useAsyncResource, toError } from "../hooks.js";
import { turnAgentLabel, turnSkipText, turnStatusText } from "../rounds.js";
import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

type Control = "pause" | "resume" | "stop";

/**
 * The active Round's Turns in order, each with its status, and Pause, Resume and Stop for a user
 * with `control` (each only in a valid state). With no active Round, the Room's latest Round is
 * shown when it was stopped.
 */
export function RoundProgressRegion({ companyId, detail, refreshKey, reloadRoom }: RegionProps) {
  const round = detail.activeRound;
  const api = useBoardroomApi();
  const client = useBoardroomClient(companyId);
  const [busy, setBusy] = useState<Control | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [error, setError] = useState<{ title: string; error: Error } | null>(null);
  const canControl = detail.permissions.canControl && detail.room.status === "open";

  async function run(control: Control) {
    if (!round || busy) return;
    setBusy(control);
    setError(null);
    try {
      if (control === "pause") await client.pauseRound(detail.room.id, round.id);
      else if (control === "resume") await client.resumeRound(detail.room.id, round.id);
      else {
        const result = await client.stopRound(detail.room.id, round.id);
        setConfirmingStop(false);
        if (result.cancel === "fallback" && result.fallbackRunId) {
          try {
            await cancelHostRun(api, result.fallbackRunId);
          } catch (failure) {
            const reason = toError(failure).message;
            setError({
              title: "The Round is stopped, but its run may still be running",
              error: new Error(`The run could not be cancelled (${reason}). Cancel it from the agent's run page if it keeps going.`),
            });
          }
        } else if (result.cancel === "failed") {
          setError({
            title: "The Round is stopped, but its run may still be running",
            error: new Error("The host could not cancel the run. Cancel it from the agent's run page if it keeps going."),
          });
        }
      }
      reloadRoom();
    } catch (failure) {
      setError({ title: `Could not ${control} the Round`, error: toError(failure) });
      if (["round_not_running", "round_not_found"].includes(String((failure as { code?: unknown }).code))) reloadRoom();
    } finally {
      setBusy(null);
    }
  }

  return (
    <RegionFrame region="round-progress" title="Round progress">
      {round ? (
        <ActiveRound
          round={round}
          controls={
            canControl ? (
              <Controls
                round={round}
                busy={busy}
                confirmingStop={confirmingStop}
                onConfirmStop={setConfirmingStop}
                onRun={(control) => void run(control)}
              />
            ) : null
          }
        />
      ) : (
        <NoActiveRound companyId={companyId} detail={detail} refreshKey={refreshKey} />
      )}
      {error ? <ErrorNotice title={error.title} error={error.error} /> : null}
    </RegionFrame>
  );
}

function Controls({
  round,
  busy,
  confirmingStop,
  onConfirmStop,
  onRun,
}: {
  round: RoundView;
  busy: Control | null;
  confirmingStop: boolean;
  onConfirmStop: (value: boolean) => void;
  onRun: (control: Control) => void;
}) {
  if (confirmingStop) {
    return (
      <div role="alertdialog" aria-label="Stop this Round?" className="br-notice br-stack">
        <p>
          <strong>Stop this Round?</strong>
        </p>
        <p>The agent that is answering is cancelled where possible, and the Turns still waiting are skipped. This cannot be undone.</p>
        <div className="br-footer">
          <button type="button" className="br-btn" onClick={() => onConfirmStop(false)} disabled={busy !== null}>
            Cancel
          </button>
          <button type="button" className="br-btn br-btn-primary" onClick={() => onRun("stop")} disabled={busy !== null}>
            {busy === "stop" ? "Stopping…" : "Stop Round"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="br-row">
      {round.status === "running" ? (
        <button type="button" className="br-btn" onClick={() => onRun("pause")} disabled={busy !== null}>
          {busy === "pause" ? "Pausing…" : "Pause"}
        </button>
      ) : null}
      {round.status === "paused" ? (
        <button type="button" className="br-btn" onClick={() => onRun("resume")} disabled={busy !== null}>
          {busy === "resume" ? "Resuming…" : "Resume"}
        </button>
      ) : null}
      <button type="button" className="br-btn" onClick={() => onConfirmStop(true)} disabled={busy !== null}>
        Stop
      </button>
    </div>
  );
}

/** No Round is active: say so, unless the latest Round was stopped, which stays visible. */
function NoActiveRound({ companyId, detail, refreshKey }: Pick<RegionProps, "companyId" | "detail" | "refreshKey">) {
  const client = useBoardroomClient(companyId);
  const rounds = useAsyncResource(() => client.listRounds(detail.room.id), [client, detail.room.id, detail.room.updatedAt], refreshKey);
  const latest = rounds.data?.rounds[0];
  if (latest && latest.status === "stopped") return <TurnList round={latest} note="was stopped" />;
  return (
    <>
      <Placeholder>No Round is running.</Placeholder>
      {rounds.error ? <ErrorNotice title="Could not load the last Round" error={rounds.error} onRetry={rounds.reload} /> : null}
    </>
  );
}

function ActiveRound({ round, controls }: { round: RoundView; controls: React.ReactNode }) {
  return <TurnList round={round} controls={controls} note={round.status === "paused" ? "paused: no new Turn starts until you resume" : undefined} />;
}

function TurnList({ round, controls, note }: { round: RoundView; controls?: React.ReactNode; note?: string }) {
  const done = round.turns.filter((turn) => turn.status === "finished").length;
  return (
    <div className="br-stack" data-round-status={round.status}>
      <p>
        <strong>Round {round.seq}</strong> <span className="br-muted">· {round.status}</span>{" "}
        <span className="br-muted br-small">
          ({done} of {round.turns.length} turns done)
        </span>
      </p>
      {note ? <p className="br-notice br-small" role="status">{`Round ${round.seq} ${note}.`}</p> : null}
      {controls}
      <ol className="br-turns">
        {round.turns.map((turn) => (
          <li key={turn.id} className="br-turn" data-turn-status={turn.status} data-turn-outcome={turn.outcome ?? ""}>
            <span className="br-turn-agent">{turnAgentLabel(turn)}</span>{" "}
            <span className="br-muted">{turnStatusText(turn)}</span>
            {turn.hostMessage ? <> <span className="br-muted br-small">{turn.hostMessage}</span></> : null}
            {turn.outcome === "skipped" ? (
              <> <span className="br-muted br-small" data-skip-reason>{turnSkipText(turn)}</span></>
            ) : turn.status === "finished" || turn.cost.events > 0 ? (
              <> <TurnCost cost={turn.cost} /></>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
