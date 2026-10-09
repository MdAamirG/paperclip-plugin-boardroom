import type { TurnCost as TurnCostFigures } from "../../api/types.js";
import { formatSpend, formatTokens } from "../cost-format.js";

/** One Turn's own cost: spend and tokens ("$0 (subscription)" on subscription billing). */
export function TurnCost({ cost }: { cost: TurnCostFigures }) {
  return (
    <span className="br-turn-cost br-muted br-small" data-turn-cost>
      {formatSpend(cost.costCents, cost.subscriptionBilled)}
      {cost.events > 0 ? ` · ${formatTokens(cost)}` : ""}
    </span>
  );
}
