import { useId, useState } from "react";
import { Spinner } from "@paperclipai/plugin-sdk/ui";
import { searchCompanyIssues, useBoardroomApi, type HostIssue } from "../api.js";
import { toError } from "../hooks.js";
import { ErrorNotice } from "./ErrorNotice.js";

export interface PickedIssue {
  id: string;
  label: string;
}

/**
 * Optional "linked task": search the company's tasks (the host's issue API) and pick one. This is the
 * simplest control that works without a host picker for issues; Enter searches, it never submits the form.
 */
export function IssuePicker({
  companyId,
  value,
  onChange,
}: {
  companyId: string;
  value: PickedIssue | null;
  onChange: (issue: PickedIssue | null) => void;
}) {
  const api = useBoardroomApi();
  const inputId = useId();
  const [text, setText] = useState("");
  const [results, setResults] = useState<HostIssue[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function search() {
    const query = text.trim();
    if (!query) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await searchCompanyIssues(api, companyId, query));
    } catch (failure) {
      setResults(null);
      setError(toError(failure));
    } finally {
      setSearching(false);
    }
  }

  if (value) {
    return (
      <div className="br-row">
        <span className="br-chip">{value.label}</span>
        <button type="button" className="br-btn" onClick={() => onChange(null)}>
          Remove linked task
        </button>
      </div>
    );
  }

  return (
    <div className="br-stack">
      <div className="br-row">
        <input
          id={inputId}
          type="search"
          className="br-input br-grow"
          placeholder="Search tasks by title or identifier"
          aria-label="Search tasks to link"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
        />
        <button type="button" className="br-btn" onClick={() => void search()} disabled={searching || !text.trim()}>
          Search
        </button>
        {searching ? <Spinner size="sm" label="Searching tasks" /> : null}
      </div>
      {error ? <ErrorNotice title="Could not search tasks" error={error} /> : null}
      {results && results.length === 0 ? <p className="br-muted">No tasks match “{text.trim()}”.</p> : null}
      {results && results.length > 0 ? (
        <ul className="br-pick-list" aria-label="Matching tasks">
          {results.map((issue) => {
            const label = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
            return (
              <li key={issue.id}>
                <button
                  type="button"
                  className="br-pick-button"
                  onClick={() => {
                    onChange({ id: issue.id, label });
                    setResults(null);
                  }}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
