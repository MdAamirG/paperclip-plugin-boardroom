import type { TurnView } from "../api/types.js";
import { shortId } from "./format.js";

/** Who a Turn belongs to, for labels. A Turn whose agent record is gone shows its short id. */
export function turnAgentLabel(turn: Pick<TurnView, "agentName" | "agentId">): string {
  return turn.agentName ?? `Removed agent (${shortId(turn.agentId)})`;
}

/** The status of a Turn in words: queued, running, or how it finished. */
export function turnStatusText(turn: Pick<TurnView, "status" | "outcome">): string {
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
      return "Skipped";
    default:
      return "Finished";
  }
}

/** Why a Turn was skipped, in words; empty for a Turn that was not skipped. */
export function turnSkipText(turn: Pick<TurnView, "outcome" | "skipReason">): string {
  if (turn.outcome !== "skipped") return "";
  switch (turn.skipReason) {
    case "not_invokable":
      return "the agent cannot be woken";
    case "stopped":
      return "the Round was stopped";
    default:
      return "";
  }
}
