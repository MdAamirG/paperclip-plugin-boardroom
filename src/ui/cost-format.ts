import type { CostFigures } from "../api/types.js";

/** At this share of the turn cap (percent) the cost strip warns. */
export const CAP_WARNING_PERCENT = 80;

export type CapState = "ok" | "warning" | "reached";

/** `reached` at or over the cap, `warning` from 80% of it (32 of 40, not 31 of 40), else `ok`. */
export function capState(turnsUsed: number, maxTotalTurns: number): CapState {
  if (maxTotalTurns > 0 && turnsUsed >= maxTotalTurns) return "reached";
  if (maxTotalTurns > 0 && turnsUsed * 100 >= maxTotalTurns * CAP_WARNING_PERCENT) return "warning";
  return "ok";
}

/** Cents as dollars, for example `$1.25`. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Spend as text: dollars, or "$0 (subscription)" when every cost event is subscription billed at zero cents. */
export function formatSpend(cents: number, subscriptionBilled: boolean): string {
  return subscriptionBilled && cents === 0 ? "$0 (subscription)" : formatCents(cents);
}

export const formatTokenCount = (n: number): string => n.toLocaleString("en-US");

/** `1,200 in · 300 cached · 80 out`, leaving out cached tokens when there are none. */
export function formatTokens(figures: Pick<CostFigures, "inputTokens" | "cachedInputTokens" | "outputTokens">): string {
  const parts = [`${formatTokenCount(figures.inputTokens)} in`];
  if (figures.cachedInputTokens > 0) parts.push(`${formatTokenCount(figures.cachedInputTokens)} cached`);
  parts.push(`${formatTokenCount(figures.outputTokens)} out`);
  return parts.join(" · ");
}
