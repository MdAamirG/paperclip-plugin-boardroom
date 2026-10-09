import { useState } from "react";
import { useHostNavigation, type PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import type { IssueRoomView } from "../../api/types.js";
import { useBoardroomClient } from "../api.js";
import { useAsyncResource } from "../hooks.js";
import { boardroomPaths } from "../route.js";
import { BoardroomStyles } from "../styles.js";

/**
 * The `toolbarButton` slot on an issue page: "From Room: <title>" when the issue is linked to a Room
 * (created from one, or linked to one). Renders nothing while loading and when there is no link; a
 * failed lookup shows a small error chip with a retry, never a silent blank. Loads once per issue
 * (the issue page has no Boardroom stream).
 */
export function FromRoomChip({ context }: { context: PluginHostContext }) {
  const issueId = context.entityType === "issue" ? context.entityId : null;
  const client = useBoardroomClient(context.companyId ?? "");
  const lookup = useAsyncResource(
    async () => (issueId ? (await client.listRoomsForIssue(issueId)).rooms : []),
    [client, issueId],
  );

  if (!issueId || lookup.loading) return null;
  if (lookup.error && !lookup.data) {
    return (
      <>
        <BoardroomStyles />
        <span role="status" className="br-chip br-small" title={lookup.error.message}>
          From Room: unavailable
          <button type="button" onClick={lookup.reload} aria-label="Retry loading the linked Room">
            Retry
          </button>
        </span>
      </>
    );
  }
  const rooms = lookup.data ?? [];
  if (rooms.length === 0) return null;
  return (
    <>
      <BoardroomStyles />
      <RoomChips rooms={rooms} />
    </>
  );
}

function RoomChips({ rooms }: { rooms: IssueRoomView[] }) {
  const navigation = useHostNavigation();
  const [open, setOpen] = useState(false);
  const [first, ...others] = rooms as [IssueRoomView, ...IssueRoomView[]];
  return (
    <span className="br-from-room">
      <a {...navigation.linkProps(boardroomPaths.room(first.roomId))} className="br-chip br-small">
        From Room: {first.title}
      </a>
      {others.length > 0 ? (
        <>
          <button
            type="button"
            className="br-chip br-small"
            aria-expanded={open}
            aria-label={`${others.length} more linked Rooms`}
            onClick={() => setOpen((value) => !value)}
          >
            +{others.length}
          </button>
          {open ? (
            <ul className="br-from-room-list" aria-label="Linked Rooms">
              {rooms.map((room) => (
                <li key={room.roomId}>
                  <a {...navigation.linkProps(boardroomPaths.room(room.roomId))} className="br-link">
                    {room.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
