import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/** Filled by the notes and transcript ticket. */
export function TranscriptRegion(_props: RegionProps) {
  return (
    <RegionFrame region="transcript" title="Transcript">
      <Placeholder>The discussion will appear here.</Placeholder>
    </RegionFrame>
  );
}
