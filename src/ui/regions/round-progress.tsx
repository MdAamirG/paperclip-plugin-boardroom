import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/** Filled by the Round tickets. They show Pause, Resume and Stop only when `detail.permissions.canControl` is true. */
export function RoundProgressRegion({ detail }: RegionProps) {
  return (
    <RegionFrame region="round-progress" title="Round progress">
      <Placeholder>{detail.activeRound ? "A Round is in progress." : "No Round is running."}</Placeholder>
    </RegionFrame>
  );
}
