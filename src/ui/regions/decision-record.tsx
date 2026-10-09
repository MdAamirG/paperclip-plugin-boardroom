import { useState } from "react";
import { MarkdownBlock, MarkdownEditor, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { DecisionView, RoomDetail } from "../../api/types.js";
import { useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { formatTimestamp, shortId } from "../format.js";
import { RegionFrame, type RegionProps } from "./frame.js";

/**
 * The Decision record: what the Room decided and why. Everyone who can read the Room sees it;
 * only the Owner or a company owner or admin (`permissions.canControl`) gets the Edit action.
 * The editor keeps its draft when a save fails, and an empty text clears the record.
 */
export function DecisionRecordRegion({ companyId, detail, reloadRoom }: RegionProps) {
  const client = useBoardroomClient(companyId);
  const { userId } = useHostContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // The answer to our own save shows at once; the refetch that follows replaces it with the same data.
  const [saved, setSaved] = useState<RoomDetail | null>(null);

  const canEdit = detail.permissions.canControl;
  const current = saved && saved.room.updatedAt >= detail.room.updatedAt ? saved : detail;
  const decision = current.decision;

  function startEditing() {
    setDraft(decision?.markdown ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel() {
    if (saving) return;
    setEditing(false);
    setError(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const answer = await client.updateDecision(detail.room.id, { decisionMd: draft });
      setSaved(answer);
      setEditing(false);
      reloadRoom();
    } catch (failure) {
      // Stay in the editor with the draft untouched, so nothing typed is lost.
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setSaving(false);
    }
  }

  const blank = draft.trim() === "";
  const clearing = blank && decision !== null;

  return (
    <RegionFrame region="decision-record" title="Decision record">
      {editing ? (
        <div className="br-stack">
          <div role="group" aria-label="Decision record text">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder="Write what the Room decided and why"
              bordered
              onSubmit={() => void save()}
            />
          </div>
          {clearing ? <p className="br-muted br-small">Saving an empty text removes the Decision record.</p> : null}
          {error ? <ErrorNotice title="Could not save the Decision record" error={error} /> : null}
          <div className="br-footer">
            <button type="button" className="br-btn" onClick={cancel} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="br-btn br-btn-primary" onClick={() => void save()} disabled={saving || (blank && !decision)}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : decision ? (
        <div className="br-stack">
          <MarkdownBlock content={decision.markdown} />
          <p className="br-muted br-small">
            Recorded by {writerName(decision, userId)}, <time dateTime={decision.at}>{formatTimestamp(decision.at)}</time>
          </p>
          {canEdit ? (
            <div className="br-row">
              <button type="button" className="br-btn" onClick={startEditing}>
                Edit
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="br-stack">
          <p className="br-muted">
            {canEdit
              ? "No decision is recorded yet. Write down what this Room decided and why, so everyone can find the outcome here."
              : "No decision is recorded yet. The Room Owner or a company admin can record one."}
          </p>
          {canEdit ? (
            <div className="br-row">
              <button type="button" className="br-btn" onClick={startEditing}>
                Record decision
              </button>
            </div>
          ) : null}
        </div>
      )}
    </RegionFrame>
  );
}

/** The writer as a person reads it: their name, "You", or a short id when the host gives no name. */
function writerName(decision: DecisionView, currentUserId: string | null | undefined): string {
  if (decision.writer.userId === currentUserId) return "You";
  return decision.writer.name ?? `Board user ${shortId(decision.writer.userId)}`;
}
