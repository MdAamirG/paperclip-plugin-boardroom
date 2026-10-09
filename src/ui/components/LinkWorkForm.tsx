import { useState, type FormEvent } from "react";
import { useBoardroomClient } from "../api.js";
import { toError } from "../hooks.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { IssuePicker, type PickedIssue } from "./IssuePicker.js";

/** "Link existing task": search the company's tasks, pick one, link it. Cancel left, Link right. */
export function LinkWorkForm({
  companyId,
  roomId,
  onLinked,
  onCancel,
}: {
  companyId: string;
  roomId: string;
  onLinked: () => void;
  onCancel: () => void;
}) {
  const client = useBoardroomClient(companyId);
  const [issue, setIssue] = useState<PickedIssue | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !issue) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.addWorkLink(roomId, { issueId: issue.id });
      onLinked();
    } catch (failure) {
      setError(toError(failure));
      setSubmitting(false);
    }
  }

  return (
    <form className="br-stack" onSubmit={(event) => void submit(event)} noValidate aria-label="Link existing task">
      <IssuePicker companyId={companyId} value={issue} onChange={setIssue} />
      {error ? <ErrorNotice title="Could not link the task" error={error} /> : null}
      <div className="br-footer">
        <button type="button" className="br-btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="br-btn br-btn-primary" disabled={submitting || !issue}>
          {submitting ? "Linking…" : "Link task"}
        </button>
      </div>
    </form>
  );
}
