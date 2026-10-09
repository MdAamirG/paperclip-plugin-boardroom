import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/** Filled by the follow-up work ticket. `detail.workLinks` already lists the linked tasks. */
export function FollowUpWorkRegion(_props: RegionProps) {
  return (
    <RegionFrame region="follow-up-work" title="Follow-up work">
      <Placeholder>Tasks created from or linked to this Room will appear here.</Placeholder>
    </RegionFrame>
  );
}
