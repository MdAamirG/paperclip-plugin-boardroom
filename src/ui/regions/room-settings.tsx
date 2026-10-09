import { useId, useState, type FormEvent } from "react";
import { useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { toError } from "../hooks.js";
import { MAX_TURN_CAP, MIN_TURN_CAP, TITLE_MAX_LENGTH, TOPIC_MAX_LENGTH } from "../limits.js";
import { RegionFrame, type RegionProps } from "./frame.js";

const ROUND_ACTIVE_REASON = "A Round is in progress, so the Room cannot be changed or closed. Stop it or wait for it to finish.";

/**
 * Title, topic and turn cap, plus "Close Room". Shown only with `control` on an open Room (a closed
 * Room has the banner instead). While a Round is active every control is disabled and the reason is
 * shown: settings and closing wait until the Round is over.
 */
export function RoomSettingsRegion({ companyId, detail, reloadRoom }: RegionProps) {
  const { room } = detail;
  if (!detail.permissions.canControl || room.status !== "open") return null;
  return (
    <RegionFrame region="room-settings" title="Room settings">
      <SettingsForm
        // Saved values that differ (our own save, or another board member's) start the form from them again.
        key={JSON.stringify([room.id, room.title, room.topic, room.maxTotalTurns])}
        companyId={companyId}
        detail={detail}
        reloadRoom={reloadRoom}
      />
      <CloseRoom companyId={companyId} detail={detail} reloadRoom={reloadRoom} />
    </RegionFrame>
  );
}

function SettingsForm({ companyId, detail, reloadRoom }: Pick<RegionProps, "companyId" | "detail" | "reloadRoom">) {
  const client = useBoardroomClient(companyId);
  const { room } = detail;
  const locked = detail.activeRound !== null;
  const ids = { title: useId(), topic: useId(), cap: useId(), titleError: useId(), topicError: useId(), capError: useId() };
  const [title, setTitle] = useState(room.title);
  const [topic, setTopic] = useState(room.topic);
  const [cap, setCap] = useState(String(room.maxTotalTurns));
  const [errors, setErrors] = useState<{ title?: string; topic?: string; cap?: string }>({});
  const [error, setError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const capNumber = Number(cap);
  const changed = title.trim() !== room.title || topic.trim() !== room.topic || (cap.trim() !== "" && capNumber !== room.maxTotalTurns);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || locked) return;
    const next: typeof errors = {};
    if (title.trim() === "") next.title = "Enter a title.";
    else if (title.trim().length > TITLE_MAX_LENGTH) next.title = `The title is at most ${TITLE_MAX_LENGTH} characters.`;
    if (topic.trim() === "") next.topic = "Enter a topic.";
    else if (topic.trim().length > TOPIC_MAX_LENGTH) next.topic = `The topic is at most ${TOPIC_MAX_LENGTH} characters.`;
    if (!Number.isInteger(capNumber) || cap.trim() === "" || capNumber < MIN_TURN_CAP || capNumber > MAX_TURN_CAP) {
      next.cap = `The turn cap is a whole number from ${MIN_TURN_CAP} to ${MAX_TURN_CAP}.`;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const patch: { title?: string; topic?: string; maxTotalTurns?: number } = {};
    if (title.trim() !== room.title) patch.title = title.trim();
    if (topic.trim() !== room.topic) patch.topic = topic.trim();
    if (capNumber !== room.maxTotalTurns) patch.maxTotalTurns = capNumber;
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      await client.updateRoom(room.id, patch);
      setDone(true);
      reloadRoom();
    } catch (failure) {
      // Keep what was typed; a Round that started or a Room that closed in the meantime refetches the Room.
      setError(toError(failure));
      if (["round_active", "room_closed"].includes(String((failure as { code?: unknown }).code))) reloadRoom();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="br-stack" onSubmit={(event) => void submit(event)} noValidate aria-label="Room settings">
      {locked ? (
        <p className="br-muted br-small" role="status">
          {ROUND_ACTIVE_REASON}
        </p>
      ) : null}
      <div className="br-field">
        <label className="br-label" htmlFor={ids.title}>
          Title
        </label>
        <input
          id={ids.title}
          className="br-input"
          value={title}
          maxLength={TITLE_MAX_LENGTH}
          disabled={locked}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? ids.titleError : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        {errors.title ? (
          <p id={ids.titleError} className="br-error-text br-small">
            {errors.title}
          </p>
        ) : null}
      </div>
      <div className="br-field">
        <label className="br-label" htmlFor={ids.topic}>
          Topic
        </label>
        <textarea
          id={ids.topic}
          className="br-input"
          value={topic}
          disabled={locked}
          aria-invalid={errors.topic ? true : undefined}
          aria-describedby={errors.topic ? ids.topicError : undefined}
          onChange={(event) => setTopic(event.target.value)}
        />
        {errors.topic ? (
          <p id={ids.topicError} className="br-error-text br-small">
            {errors.topic}
          </p>
        ) : null}
      </div>
      <div className="br-field">
        <label className="br-label" htmlFor={ids.cap}>
          Turn cap
        </label>
        <input
          id={ids.cap}
          className="br-input br-input-narrow"
          type="number"
          min={MIN_TURN_CAP}
          max={MAX_TURN_CAP}
          value={cap}
          disabled={locked}
          aria-invalid={errors.cap ? true : undefined}
          aria-describedby={errors.cap ? ids.capError : undefined}
          onChange={(event) => setCap(event.target.value)}
        />
        {errors.cap ? (
          <p id={ids.capError} className="br-error-text br-small">
            {errors.cap}
          </p>
        ) : (
          <p className="br-muted br-small">Total Turns allowed in this Room. Lowering it only stops new Rounds.</p>
        )}
      </div>
      {error ? <ErrorNotice title="Could not save the settings" error={error} /> : null}
      {done && !error ? (
        <p className="br-muted br-small" role="status">
          Settings saved.
        </p>
      ) : null}
      <div className="br-row">
        <button type="submit" className="br-btn br-btn-primary" disabled={locked || saving || !changed}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

function CloseRoom({ companyId, detail, reloadRoom }: Pick<RegionProps, "companyId" | "detail" | "reloadRoom">) {
  const client = useBoardroomClient(companyId);
  const locked = detail.activeRound !== null;
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function close() {
    if (closing) return;
    setClosing(true);
    setError(null);
    try {
      await client.closeRoom(detail.room.id);
      setConfirming(false);
      reloadRoom();
    } catch (failure) {
      setError(toError(failure));
      if (["round_active", "room_closed"].includes(String((failure as { code?: unknown }).code))) reloadRoom();
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="br-stack">
      {confirming && !locked ? (
        <div role="alertdialog" aria-label="Close this Room?" className="br-notice br-stack">
          <p>
            <strong>Close this Room?</strong>
          </p>
          <p>A closed Room keeps its record but takes no more messages, Rounds or changes. This cannot be undone.</p>
          <div className="br-footer">
            <button type="button" className="br-btn" onClick={() => setConfirming(false)} disabled={closing}>
              Cancel
            </button>
            <button type="button" className="br-btn br-btn-primary" onClick={() => void close()} disabled={closing}>
              {closing ? "Closing…" : "Close Room"}
            </button>
          </div>
        </div>
      ) : (
        <div className="br-row">
          <button type="button" className="br-btn" onClick={() => setConfirming(true)} disabled={locked}>
            Close Room
          </button>
        </div>
      )}
      {error ? <ErrorNotice title="Could not close the Room" error={error} /> : null}
    </div>
  );
}
