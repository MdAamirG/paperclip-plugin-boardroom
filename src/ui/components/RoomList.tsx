import { Spinner, StatusBadge, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { RoomSummary } from "../../api/types.js";
import { formatTimestamp } from "../format.js";
import { useAsyncResource, useRoomChanged, useStreamFallbackPoll } from "../hooks.js";
import { useBoardroomClient } from "../api.js";
import { boardroomPaths } from "../route.js";
import { ErrorNotice, LiveUpdatesNotice } from "./ErrorNotice.js";

/** `/boardroom`: the company's Rooms, newest activity first. Refetches on any `room.changed`. */
export function RoomListPage({ companyId }: { companyId: string }) {
  const client = useBoardroomClient(companyId);
  const navigation = useHostNavigation();
  const live = useRoomChanged(companyId, null);
  const poll = useStreamFallbackPoll(live.streamError !== null, false);
  const rooms = useAsyncResource(() => client.listRooms(), [client], live.tick + poll.tick);

  const canCreate = rooms.data?.permissions.canPost === true;
  const newRoomLink = (
    <a {...navigation.linkProps(boardroomPaths.create())} className="br-btn br-btn-primary">
      New Room
    </a>
  );

  return (
    <div className="br-stack">
      <div className="br-header">
        <h1 id="boardroom-title" className="br-title">
          Boardroom
        </h1>
        {canCreate && rooms.data && rooms.data.rooms.length > 0 ? newRoomLink : null}
      </div>
      <LiveUpdatesNotice error={live.streamError} intervalMs={poll.intervalMs} />
      {rooms.error ? <ErrorNotice title="Could not load Rooms" error={rooms.error} onRetry={rooms.reload} /> : null}
      {rooms.loading ? (
        <p className="br-row" aria-live="polite">
          <Spinner size="sm" label="Loading Rooms" />
          <span className="br-muted">Loading Rooms…</span>
        </p>
      ) : null}
      {rooms.data && rooms.data.rooms.length === 0 ? (
        <div className="br-empty">
          <p>
            <strong>No Rooms yet.</strong>
          </p>
          <p className="br-muted">
            {canCreate
              ? "A Room is a discussion between you and the agents you pick. Create one to get started."
              : "Rooms the board creates will appear here. Your role can read Rooms but not create them."}
          </p>
          {canCreate ? newRoomLink : null}
        </div>
      ) : null}
      {rooms.data && rooms.data.rooms.length > 0 ? <RoomTable rooms={rooms.data.rooms} /> : null}
    </div>
  );
}

function RoomTable({ rooms }: { rooms: RoomSummary[] }) {
  const navigation = useHostNavigation();
  return (
    <div className="br-table-wrap">
      <table className="br-table" aria-labelledby="boardroom-title">
        <thead>
          <tr>
            <th scope="col">Room</th>
            <th scope="col">Status</th>
            <th scope="col" className="br-num">
              Participants
            </th>
            <th scope="col">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => (
            <tr key={room.id}>
              <td>
                <a {...navigation.linkProps(boardroomPaths.room(room.id))} className="br-link">
                  {room.title}
                </a>
              </td>
              <td>
                <StatusBadge label={room.status === "open" ? "Open" : "Closed"} status={room.status === "open" ? "ok" : "pending"} />
              </td>
              <td className="br-num">{room.participantCount}</td>
              <td>
                <time dateTime={room.lastActivityAt}>{formatTimestamp(room.lastActivityAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
