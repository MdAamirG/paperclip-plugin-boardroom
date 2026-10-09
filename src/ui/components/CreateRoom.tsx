import { useId, useState, type FormEvent } from "react";
import { ProjectPicker, Spinner, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { listCompanyAgents, useBoardroomApi, useBoardroomClient } from "../api.js";
import { useAsyncResource, toError } from "../hooks.js";
import { DEFAULT_TURN_CAP, MAX_TURN_CAP, MIN_TURN_CAP, TITLE_MAX_LENGTH, TOPIC_MAX_LENGTH } from "../limits.js";
import { boardroomPaths } from "../route.js";
import { AgentPicker } from "./AgentPicker.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { IssuePicker, type PickedIssue } from "./IssuePicker.js";

interface FieldErrors {
  title?: string;
  topic?: string;
  agents?: string;
}

/**
 * `/boardroom/new`: title, topic, agents (in pick order), optional project, optional linked task and
 * the turn cap. A refused submit (any non-2xx) shows the server's message beside the form and keeps
 * every value. Cancel on the left, Create on the right, in one row.
 */
export function CreateRoomPage({ companyId }: { companyId: string }) {
  const api = useBoardroomApi();
  const client = useBoardroomClient(companyId);
  const navigation = useHostNavigation();
  const ids = { title: useId(), topic: useId(), cap: useId(), project: useId(), issue: useId(), titleError: useId(), topicError: useId(), agentsError: useId() };

  const agents = useAsyncResource(async () => {
    const all = await listCompanyAgents(api, companyId);
    // A terminated agent can never take a Turn, so it is not offered.
    return all.filter((agent) => agent.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name));
  }, [api, companyId]);

  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [issue, setIssue] = useState<PickedIssue | null>(null);
  const [cap, setCap] = useState(String(DEFAULT_TURN_CAP));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const errors: FieldErrors = {};
    if (!title.trim()) errors.title = "Enter a title.";
    if (!topic.trim()) errors.topic = "Enter the topic of the discussion.";
    if (agentIds.length === 0) errors.agents = "Pick at least one agent.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const detail = await client.createRoom({
        title: title.trim(),
        topic: topic.trim(),
        agentIds,
        projectId: projectId || null,
        linkedIssueId: issue?.id ?? null,
        // Empty means "use the default"; anything else goes to the server, which owns the 1 to 200 rule.
        maxTotalTurns: cap.trim() === "" ? null : Number(cap),
      });
      navigation.navigate(boardroomPaths.room(detail.room.id));
    } catch (failure) {
      setSubmitError(toError(failure));
      setSubmitting(false);
    }
  }

  return (
    <form className="br-stack" onSubmit={(event) => void submit(event)} noValidate aria-labelledby="boardroom-new-title">
      <h1 id="boardroom-new-title" className="br-title">
        New Room
      </h1>

      <div className="br-field">
        <label htmlFor={ids.title} className="br-label">
          Title
        </label>
        <input
          id={ids.title}
          className="br-input"
          value={title}
          maxLength={TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? ids.titleError : undefined}
        />
        {fieldErrors.title ? (
          <p id={ids.titleError} className="br-error-text" role="alert">
            {fieldErrors.title}
          </p>
        ) : null}
      </div>

      <div className="br-field">
        <label htmlFor={ids.topic} className="br-label">
          Topic
        </label>
        <textarea
          id={ids.topic}
          className="br-input"
          value={topic}
          maxLength={TOPIC_MAX_LENGTH}
          onChange={(event) => setTopic(event.target.value)}
          aria-invalid={fieldErrors.topic ? true : undefined}
          aria-describedby={fieldErrors.topic ? ids.topicError : undefined}
        />
        {fieldErrors.topic ? (
          <p id={ids.topicError} className="br-error-text" role="alert">
            {fieldErrors.topic}
          </p>
        ) : null}
      </div>

      {agents.loading ? (
        <p className="br-row" aria-live="polite">
          <Spinner size="sm" label="Loading agents" />
          <span className="br-muted">Loading agents…</span>
        </p>
      ) : null}
      {agents.error ? <ErrorNotice title="Could not load the company's agents" error={agents.error} onRetry={agents.reload} /> : null}
      {agents.data && agents.data.length === 0 ? (
        <p className="br-notice br-notice-warn">This company has no agents to invite yet. Add an agent first, then create the Room.</p>
      ) : null}
      {agents.data && agents.data.length > 0 ? (
        <>
          <AgentPicker
            agents={agents.data}
            selected={agentIds}
            onChange={setAgentIds}
            invalid={Boolean(fieldErrors.agents)}
            describedBy={fieldErrors.agents ? ids.agentsError : undefined}
          />
          {fieldErrors.agents ? (
            <p id={ids.agentsError} className="br-error-text" role="alert">
              {fieldErrors.agents}
            </p>
          ) : null}
        </>
      ) : null}

      <div className="br-field" role="group" aria-labelledby={ids.project}>
        <span id={ids.project} className="br-label">
          Project <span className="br-muted">(optional)</span>
        </span>
        <ProjectPicker companyId={companyId} value={projectId} onChange={setProjectId} placeholder="No project" noneLabel="No project" />
      </div>

      <div className="br-field" role="group" aria-labelledby={ids.issue}>
        <span id={ids.issue} className="br-label">
          Linked task <span className="br-muted">(optional)</span>
        </span>
        <IssuePicker companyId={companyId} value={issue} onChange={setIssue} />
      </div>

      <div className="br-field">
        <label htmlFor={ids.cap} className="br-label">
          Turn cap
        </label>
        <input
          id={ids.cap}
          type="number"
          inputMode="numeric"
          className="br-input br-input-narrow"
          value={cap}
          min={MIN_TURN_CAP}
          max={MAX_TURN_CAP}
          onChange={(event) => setCap(event.target.value)}
        />
        <p className="br-muted br-small">
          The most agent Turns the Room may take in total, from {MIN_TURN_CAP} to {MAX_TURN_CAP}. Default {DEFAULT_TURN_CAP}.
        </p>
      </div>

      {submitError ? <ErrorNotice title="The Room was not created" error={submitError} /> : null}

      <div className="br-footer">
        <a {...navigation.linkProps(boardroomPaths.list())} className="br-btn">
          Cancel
        </a>
        <button type="submit" className="br-btn br-btn-primary" disabled={submitting} aria-busy={submitting || undefined}>
          {submitting ? "Creating…" : "Create Room"}
        </button>
      </div>
    </form>
  );
}
