import { MarkdownBlock, Spinner, StatusBadge, useHostContext, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { RoomDetail } from "../../api/types.js";
import { getProjectName, useBoardroomApi, useBoardroomClient } from "../api.js";
import { formatTimestamp, shortId } from "../format.js";
import { useAsyncResource, useRoomChanged } from "../hooks.js";
import { boardroomPaths } from "../route.js";
import { ComposerRegion } from "../regions/composer.js";
import { CostStripRegion } from "../regions/cost-strip.js";
import { DecisionRecordRegion } from "../regions/decision-record.js";
import { FollowUpWorkRegion } from "../regions/follow-up-work.js";
import type { RegionProps } from "../regions/frame.js";
import { ParticipantsRegion } from "../regions/participants.js";
import { RoundProgressRegion } from "../regions/round-progress.js";
import { TranscriptRegion } from "../regions/transcript.js";
import { ErrorNotice, LiveUpdatesNotice } from "./ErrorNotice.js";

/** `/boardroom/:roomId`: the Room's header, Participants and the regions later tickets fill. Refetches on `room.changed` for this Room. */
export function RoomDetailPage({ companyId, roomId }: { companyId: string; roomId: string }) {
  const client = useBoardroomClient(companyId);
  const navigation = useHostNavigation();
  const live = useRoomChanged(companyId, roomId);
  const room = useAsyncResource(() => client.getRoom(roomId), [client, roomId], live.tick);

  const back = (
    <a {...navigation.linkProps(boardroomPaths.list())} className="br-link">
      ← All Rooms
    </a>
  );

  if (room.loading) {
    return (
      <div className="br-stack">
        {back}
        <p className="br-row" aria-live="polite">
          <Spinner size="sm" label="Loading Room" />
          <span className="br-muted">Loading Room…</span>
        </p>
      </div>
    );
  }

  if (!room.data) {
    return (
      <div className="br-stack">
        {back}
        <ErrorNotice title="Could not load this Room" error={room.error ?? new Error("The Room did not load.")} onRetry={room.reload} />
      </div>
    );
  }

  const regionProps: RegionProps = { companyId, detail: room.data, refreshKey: live.tick, reloadRoom: room.reload };
  return (
    <div className="br-stack">
      {back}
      {room.error ? <ErrorNotice title="Could not refresh this Room" error={room.error} onRetry={room.reload} /> : null}
      <LiveUpdatesNotice error={live.streamError} />
      <RoomHeader companyId={companyId} detail={room.data} />
      <div className="br-layout">
        <div className="br-stack">
          <RoundProgressRegion {...regionProps} />
          <TranscriptRegion {...regionProps} />
          <ComposerRegion {...regionProps} />
        </div>
        <div className="br-stack">
          <ParticipantsRegion {...regionProps} />
          <CostStripRegion {...regionProps} />
          <FollowUpWorkRegion {...regionProps} />
          <DecisionRecordRegion {...regionProps} />
        </div>
      </div>
    </div>
  );
}

function RoomHeader({ companyId, detail }: { companyId: string; detail: RoomDetail }) {
  const { room } = detail;
  const { userId } = useHostContext();
  return (
    <header className="br-stack">
      <div className="br-row">
        <h1 className="br-title">{room.title}</h1>
        <StatusBadge label={room.status === "open" ? "Open" : "Closed"} status={room.status === "open" ? "ok" : "pending"} />
      </div>
      <MarkdownBlock content={room.topic} />
      <dl className="br-meta">
        <dt>Owner</dt>
        <dd>{room.ownerUserId === userId ? "You" : `Board user ${shortId(room.ownerUserId)}`}</dd>
        <dt>Project</dt>
        <dd>{room.projectId ? <ProjectName companyId={companyId} projectId={room.projectId} /> : <span className="br-muted">None</span>}</dd>
        <dt>Turn cap</dt>
        <dd>{room.maxTotalTurns}</dd>
        <dt>Created</dt>
        <dd>
          <time dateTime={room.createdAt}>{formatTimestamp(room.createdAt)}</time>
        </dd>
        {room.closedAt ? (
          <>
            <dt>Closed</dt>
            <dd>
              <time dateTime={room.closedAt}>{formatTimestamp(room.closedAt)}</time>
            </dd>
          </>
        ) : null}
      </dl>
    </header>
  );
}

function ProjectName({ companyId, projectId }: { companyId: string; projectId: string }) {
  const api = useBoardroomApi();
  const project = useAsyncResource(() => getProjectName(api, projectId), [api, companyId, projectId]);
  if (project.loading) return <span className="br-muted">Loading…</span>;
  if (project.error || !project.data) {
    return (
      <span>
        Project {shortId(projectId)} <span className="br-muted br-small">(name unavailable: {project.error?.message ?? "not found"})</span>
      </span>
    );
  }
  return <span>{project.data.name}</span>;
}
