import { useEffect, useState } from "react";
import type { RoundView } from "../../api/types.js";
import { cancelHostRun, useBoardroomApi, useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { TurnCost } from "../components/TurnCost.js";
import { useAsyncResource, toError } from "../hooks.js";
import { turnAgentLabel, turnSkipText, turnStatusText } from "../rounds.js";
import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

type Control = "pause" | "resume" | "stop";

/** A run Stop could not cancel (the host has no session cancel and the run id is not known yet). */
interface AwaitedRun {
  roundId: string;
  turnId: string;
}

const RUN_MAY_BE_RUNNING = "The Round is stopped, but its run may still be running";
const RUN_NOT_CANCELLED = "The Round is stopped, but its run was not cancelled";

/**
 * The active Round's Turns in order, each with its status, and Pause, Resume and Stop for a user
 * with `control` (each only in a valid state). With no active Round, the Room's latest Round is
 * shown when it was stopped.
 *
 * Stop on a host without a session cancel answers `fallback`, and the page cancels the run through
 * the board route. When the Turn's run was still starting there is no run id yet: the page then
 * re-reads the Round on every Room change and cancels the run as soon as the Turn has its id
 * (and says so when the run ended first and its reply was kept).
 */
export function RoundProgressRegion({ companyId, detail, refreshKey, reloadRoom, onWaitingForRun }: RegionProps) {
  const round = detail.activeRound;
  const api = useBoardroomApi();
  const client = useBoardroomClient(companyId);
  const [busy, setBusy] = useState<Control | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [error, setError] = useState<{ title: string; error: Error } | null>(null);
  const [awaitedRun, setAwaitedRun] = useState<AwaitedRun | null>(null);
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
          await cancelRun(result.fallbackRunId);
        } else if (result.cancel === "fallback") {
          const turn = result.round.turns.find((candidate) => candidate.status === "running");
          if (turn) setAwaitedRun({ roundId: result.round.id, turnId: turn.id });
        } else if (result.cancel === "failed") {
          setError({
            title: RUN_MAY_BE_RUNNING,
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

  async function cancelRun(runId: string) {
    try {
      await cancelHostRun(api, runId);
    } catch (failure) {
      const reason = toError(failure).message;
      setError({
        title: RUN_MAY_BE_RUNNING,
        error: new Error(`The run could not be cancelled (${reason}). Cancel it from the agent's run page if it keeps going.`),
      });
    }
  }

  // Waiting for the run id of a run Stop could not cancel: look again on every Room change. A
  // failed read keeps the wait (the next Room change or poll tries again).
  useEffect(() => {
    if (!awaitedRun) return;
    let current = true;
    void (async () => {
      let rounds: RoundView[];
      try {
        ({ rounds } = await client.listRounds(detail.room.id));
      } catch {
        return;
      }
      if (!current) return;
      const turn = rounds.find((r) => r.id === awaitedRun.roundId)?.turns.find((t) => t.id === awaitedRun.turnId);
      if (turn?.status === "running" && !turn.runId) return; // Still being sent.
      setAwaitedRun(null);
      if (!turn) {
        setError({
          title: RUN_MAY_BE_RUNNING,
          error: new Error("The stopped Turn could not be found. Cancel its run from the agent's run page if it keeps going."),
        });
      } else if (turn.status === "running" && turn.runId) {
        await cancelRun(turn.runId);
      } else if (turn.outcome === "posted" || turn.outcome === "silent") {
        // The run ended before this page saw its id: it was not cancelled and its reply was kept.
        setError({
          title: RUN_NOT_CANCELLED,
          error: new Error("The agent's run finished before this page could cancel it, and its reply (if any) was kept."),
        });
      }
      // Skipped (no run started) or failed (cancelled, or the run failed): nothing more to do.
    })();
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cancelRun` only closes over `api`.
  }, [awaitedRun, refreshKey, client, api, detail.room.id]);

  useEffect(() => onWaitingForRun?.(awaitedRun !== null), [awaitedRun, onWaitingForRun]);

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
      {awaitedRun ? (
        <p className="br-notice br-small" role="status">
          The Round is stopped. The agent's run is still starting; it is cancelled from this page as soon as it starts. Keep this page open until then.
        </p>
      ) : null}
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
