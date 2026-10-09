import type { TurnView } from "../api/types.js";
import { shortId } from "./format.js";

/** Who a Turn belongs to, for labels. A Turn whose agent record is gone shows its short id. */
export function turnAgentLabel(turn: Pick<TurnView, "agentName" | "agentId">): string {
  return turn.agentName ?? `Removed agent (${shortId(turn.agentId)})`;
}

/** The status of a Turn in words: queued, running, or how it finished. */
export function turnStatusText(turn: Pick<TurnView, "status" | "outcome"> & Partial<Pick<TurnView, "skipReason">>): string {
  if (turn.status === "queued") return "Waiting";
  if (turn.status === "running") return "Answering…";
  switch (turn.outcome) {
    case "posted":
      return "Replied";
    case "silent":
      return "Stayed silent";
    case "failed":
      return "Failed";
    case "skipped":
      return turn.skipReason === "stopped" ? "Stopped" : "Skipped";
    default:
      return "Finished";
  }
}
