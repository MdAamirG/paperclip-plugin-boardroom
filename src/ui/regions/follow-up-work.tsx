import { useState } from "react";
import { StatusBadge, useHostContext, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import type { WorkLinkView } from "../../api/types.js";
import { BoardroomApiError, useBoardroomClient } from "../api.js";
import { CreateWorkForm } from "../components/CreateWorkForm.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { LinkWorkForm } from "../components/LinkWorkForm.js";
import { formatTimestamp, shortId } from "../format.js";
import { toError } from "../hooks.js";
import { RegionFrame, type RegionProps } from "./frame.js";

const STATUS_BADGES: Record<string, { label: string; variant: StatusBadgeVariant }> = {
  backlog: { label: "Backlog", variant: "pending" },
  todo: { label: "To do", variant: "pending" },
  in_progress: { label: "In progress", variant: "info" },
  in_review: { label: "In review", variant: "info" },
  blocked: { label: "Blocked", variant: "error" },
  done: { label: "Done", variant: "ok" },
  cancelled: { label: "Cancelled", variant: "warning" },
};

function statusBadge(status: string): { label: string; variant: StatusBadgeVariant } {
  return STATUS_BADGES[status] ?? { label: status.replace(/_/g, " "), variant: "pending" };
}

/**
 * Follow-up work: the Room's tasks with live status, "Create follow-up work", "Link existing task"
 * and Unlink per row. Hidden for viewers. It stays usable in a closed Room, so it follows the role
 * and not `canPost` (which is false once the Room is closed).
 */
export function FollowUpWorkRegion(props: RegionProps) {
  if (props.detail.permissions.role === "viewer") return null;
  return <FollowUpWorkPanel {...props} />;
}

type Mode = "idle" | "create" | "link";

function FollowUpWorkPanel({ companyId, detail, reloadRoom }: RegionProps) {
  const client = useBoardroomClient(companyId);
  const [mode, setMode] = useState<Mode>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, Error>>({});
  const { room, workLinks } = detail;

  async function unlink(link: WorkLinkView) {
    if (unlinking) return;
    setUnlinking(link.issueId);
    setRowErrors(({ [link.issueId]: _cleared, ...rest }) => rest);
    try {
      await client.removeWorkLink(room.id, link.issueId);
      reloadRoom();
    } catch (failure) {
      if (failure instanceof BoardroomApiError && failure.status === 404) {
        // The link is already gone (removed elsewhere): reload so the stale row disappears.
        reloadRoom();
      } else {
        setRowErrors((current) => ({ ...current, [link.issueId]: toError(failure) }));
      }
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <RegionFrame region="follow-up-work" title="Follow-up work">
      {notice ? (
        <p role="status" className="br-notice br-notice-warn">
          {notice}
        </p>
      ) : null}

      {workLinks.length === 0 ? (
        <p className="br-muted">No follow-up work yet. Create a task from this Room or link an existing one.</p>
      ) : (
        <ul className="br-work-list" aria-label="Follow-up work">
          {workLinks.map((link) => (
            <WorkRow key={link.id} link={link} busy={unlinking === link.issueId} error={rowErrors[link.issueId] ?? null} onUnlink={() => void unlink(link)} />
          ))}
        </ul>
      )}

      {mode === "idle" ? (
        <div className="br-row">
          <button
            type="button"
            className="br-btn br-btn-primary"
            onClick={() => {
              setNotice(null);
              setMode("create");
            }}
          >
            Create follow-up work
          </button>
          <button
            type="button"
            className="br-btn"
            onClick={() => {
              setNotice(null);
              setMode("link");
            }}
          >
            Link existing task
          </button>
        </div>
      ) : null}

      {mode === "create" ? (
        <CreateWorkForm
          companyId={companyId}
          roomId={room.id}
          roomProjectId={room.projectId}
          onCancel={() => setMode("idle")}
          onCreated={(response) => {
            setMode("idle");
            if (!response.planSaved) {
              const task = response.issue.identifier ? `The task ${response.issue.identifier}` : "The task";
              setNotice(`${task} was created, but its plan could not be saved${response.planError ? `: ${response.planError}` : ""}. Add the plan on the task page.`);
            }
            reloadRoom();
          }}
        />
      ) : null}

      {mode === "link" ? (
        <LinkWorkForm
          companyId={companyId}
          roomId={room.id}
          onCancel={() => setMode("idle")}
          onLinked={() => {
            setMode("idle");
            reloadRoom();
          }}
        />
      ) : null}
    </RegionFrame>
  );
}

function WorkRow({ link, busy, error, onUnlink }: { link: WorkLinkView; busy: boolean; error: Error | null; onUnlink: () => void }) {
  const { userId } = useHostContext();
  const navigation = useHostNavigation();
  const issue = link.issue;
  const label = issue ? [issue.identifier, issue.title].filter(Boolean).join(" ") : `Task ${shortId(link.issueId)}`;
  const badge = issue ? statusBadge(issue.status) : { label: "Unavailable", variant: "warning" as StatusBadgeVariant };
  const assignee = issue?.assigneeAgentId
    ? (issue.assigneeAgentName ?? `Agent ${shortId(issue.assigneeAgentId)}`)
    : issue?.assigneeUserId
      ? `Board user ${shortId(issue.assigneeUserId)}`
      : null;
  const who = link.byUserId === userId ? "You" : `Board user ${shortId(link.byUserId)}`;

  return (
    <li className="br-work-row">
      <div className="br-row">
        <StatusBadge label={badge.label} status={badge.variant} />
        {issue ? (
          <a className="br-work-link" {...navigation.linkProps(`/issues/${issue.identifier ?? issue.id}`)}>
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
      </div>
      <p className="br-muted br-small">
        {link.relation === "created" ? "Created" : "Linked"} by {who} on {formatTimestamp(link.createdAt)}
        {issue ? ` · ${assignee ? `Assigned to ${assignee}` : "Unassigned"}` : " · This task can no longer be read"}
      </p>
      <div className="br-row">
        <button type="button" className="br-btn" onClick={onUnlink} disabled={busy} aria-label={`Unlink ${label}`}>
          {busy ? "Unlinking…" : "Unlink"}
        </button>
      </div>
      {error ? <ErrorNotice title="Could not unlink the task" error={error} /> : null}
    </li>
  );
}
