import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/** Filled by the cost ticket. */
export function CostStripRegion(_props: RegionProps) {
  return (
    <RegionFrame region="cost" title="Cost">
      <Placeholder>Cost for this Room will appear here.</Placeholder>
    </RegionFrame>
  );
}
