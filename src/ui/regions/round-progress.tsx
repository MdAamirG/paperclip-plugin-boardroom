import type { RoundView } from "../../api/types.js";
import { TurnCost } from "../components/TurnCost.js";
import { turnAgentLabel, turnSkipText, turnStatusText } from "../rounds.js";
import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/**
 * The active Round's Turns in order, each with its status. Pause, Resume and Stop (ticket 09) go
 * here and show only when `detail.permissions.canControl` is true.
 */
export function RoundProgressRegion({ detail }: RegionProps) {
  const round = detail.activeRound;
  return (
    <RegionFrame region="round-progress" title="Round progress">
      {round ? <ActiveRound round={round} /> : <Placeholder>No Round is running.</Placeholder>}
    </RegionFrame>
  );
}

function ActiveRound({ round }: { round: RoundView }) {
  const done = round.turns.filter((turn) => turn.status === "finished").length;
  return (
    <div className="br-stack">
      <p>
        <strong>Round {round.seq}</strong> <span className="br-muted">· {round.status}</span>{" "}
        <span className="br-muted br-small">
          ({done} of {round.turns.length} turns done)
        </span>
      </p>
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
