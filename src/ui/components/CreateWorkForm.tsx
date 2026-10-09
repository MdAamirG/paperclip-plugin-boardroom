import { useId, useState, type FormEvent } from "react";
import { AssigneePicker, MarkdownEditor, ProjectPicker } from "@paperclipai/plugin-sdk/ui";
import type { CreateWorkResponse } from "../../api/types.js";
import { useBoardroomClient } from "../api.js";
import { toError } from "../hooks.js";
import { ErrorNotice } from "./ErrorNotice.js";

const TITLE_MAX = 500;

/**
 * "Create follow-up work": title, description, project (the Room's by default), assignee, optional
 * plan. A refused create shows the server's message above the footer and keeps every value.
 * Cancel on the left, Create on the right, in one row.
 */
export function CreateWorkForm({
  companyId,
  roomId,
  roomProjectId,
  onCreated,
  onCancel,
}: {
  companyId: string;
  roomId: string;
  roomProjectId: string | null;
  onCreated: (response: CreateWorkResponse) => void;
  onCancel: () => void;
}) {
  const client = useBoardroomClient(companyId);
  const ids = { title: useId(), description: useId(), project: useId(), assignee: useId(), plan: useId(), titleError: useId() };
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(roomProjectId ?? "");
  const [assignee, setAssignee] = useState("");
  const [plan, setPlan] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!title.trim()) {
      setTitleError("Enter a title for the task.");
      return;
    }
    setTitleError(null);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const [kind, id] = assignee.split(":");
      const response = await client.createWork(roomId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(projectId ? { projectId } : {}),
        ...(kind === "agent" && id ? { assigneeAgentId: id } : {}),
        ...(kind === "user" && id ? { assigneeUserId: id } : {}),
        ...(plan.trim() ? { plan } : {}),
      });
      onCreated(response);
    } catch (failure) {
      setSubmitError(toError(failure));
      setSubmitting(false);
    }
  }

  return (
    <form className="br-stack" onSubmit={(event) => void submit(event)} noValidate aria-label="Create follow-up work">
      <div className="br-field">
        <label htmlFor={ids.title} className="br-label">
          Title
        </label>
        <input
          id={ids.title}
          className="br-input"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? ids.titleError : undefined}
        />
        {titleError ? (
          <p id={ids.titleError} className="br-error-text" role="alert">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="br-field">
        <label htmlFor={ids.description} className="br-label">
          Description (optional)
        </label>
        <textarea id={ids.description} className="br-input" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>

      <div className="br-field" role="group" aria-labelledby={ids.project}>
        <span id={ids.project} className="br-label">
          Project
        </span>
        <ProjectPicker companyId={companyId} value={projectId} onChange={setProjectId} placeholder="Project" noneLabel="No project" />
      </div>

      <div className="br-field" role="group" aria-labelledby={ids.assignee}>
        <span id={ids.assignee} className="br-label">
          Assignee
        </span>
        <AssigneePicker
          companyId={companyId}
          value={assignee}
          onChange={(value) => setAssignee(value)}
          placeholder="Assignee"
          noneLabel="No assignee"
        />
      </div>

      <div className="br-field" role="group" aria-labelledby={ids.plan}>
        <span id={ids.plan} className="br-label">
          Plan (optional)
        </span>
        <MarkdownEditor value={plan} onChange={setPlan} placeholder="Write the plan in Markdown" bordered />
      </div>

      {submitError ? <ErrorNotice title="Could not create the task" error={submitError} /> : null}

      <div className="br-footer">
        <button type="button" className="br-btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="br-btn br-btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
