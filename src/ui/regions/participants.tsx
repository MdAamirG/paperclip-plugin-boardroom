import type { ParticipantView } from "../../api/types.js";
import { shortId } from "../format.js";
import { RegionFrame, type RegionProps } from "./frame.js";

/** The active Participants in join order. The Participant edit ticket adds add and remove controls here. */
export function ParticipantsRegion({ detail }: RegionProps) {
  return (
    <RegionFrame region="participants" title="Participants">
      {detail.participants.length === 0 ? (
        <p className="br-muted">No active Participants.</p>
      ) : (
        <ul className="br-participants">
          {detail.participants.map((participant) => (
            <ParticipantRow key={participant.id} participant={participant} />
          ))}
        </ul>
      )}
    </RegionFrame>
  );
}

function ParticipantRow({ participant }: { participant: ParticipantView }) {
  const detailText = [participant.role, participant.title].filter(Boolean).join(" · ");
  return (
    <li>
      <span>{participant.name ?? `Removed agent (${shortId(participant.agentId)})`}</span>
      {detailText ? <span className="br-muted br-small">{detailText}</span> : null}
    </li>
  );
}
