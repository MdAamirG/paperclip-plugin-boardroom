import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/** Filled by the Decision record ticket. `detail.room.decisionMd` already carries the text. */
export function DecisionRecordRegion(_props: RegionProps) {
  return (
    <RegionFrame region="decision-record" title="Decision record">
      <Placeholder>The Room&apos;s decision will appear here.</Placeholder>
    </RegionFrame>
  );
}
