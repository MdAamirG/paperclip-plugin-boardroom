import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { IgnoredMention, IgnoredMentionReason } from "../../api/types.js";
import { useBoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { shortId } from "../format.js";
import { toError } from "../hooks.js";
import { newIdempotencyKey } from "../idempotency.js";
import { applyMention, bodyMentions, findMentionTrigger, type MentionTrigger } from "../mentions.js";
import { RegionFrame, type RegionProps } from "./frame.js";
import { announceMessagePosted } from "./message-bus.js";

/** The client limit mirrors the server's (`MESSAGE_BODY_MAX`); the server's answer is the truth. */
export const COMPOSER_BODY_MAX = 20_000;

const IGNORED_REASON_TEXT: Record<IgnoredMentionReason, string> = {
  not_a_participant: "is not a Participant in this Room",
  removed_participant: "was removed from this Room",
  unknown_agent: "is not an agent of this company",
};

interface PickedMention {
  agentId: string;
  name: string;
}

interface Pending {
  key: string;
  signature: string;
}

/**
 * Post a note. A Markdown text area with an `@` picker limited to active Participants: picking one
 * writes `@Name` into the text and remembers the agent id, which is what the server uses.
 * Each send gets an idempotency key that is reused while the same text is retried after a failure.
 */
export function ComposerRegion({ companyId, detail, reloadRoom }: RegionProps) {
  const { canPost, role } = detail.permissions;
  return (
    <RegionFrame region="composer" title="Composer">
      {canPost ? (
        <ComposerForm companyId={companyId} detail={detail} reloadRoom={reloadRoom} />
      ) : (
        <p className="br-notice br-notice-warn" role="status">
          {detail.room.status === "closed"
            ? "This Room is closed, so it is read-only."
            : role === "viewer"
              ? "Your role can read this Room but not post in it."
              : "You cannot post in this Room."}
        </p>
      )}
    </RegionFrame>
  );
}

function ComposerForm({ companyId, detail, reloadRoom }: Pick<RegionProps, "companyId" | "detail" | "reloadRoom">) {
  const roomId = detail.room.id;
  const client = useBoardroomClient(companyId);
  const fieldId = useId();
  const listId = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const sending = useRef(false);
  const pending = useRef<Pending | null>(null);

  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [ignored, setIgnored] = useState<IgnoredMention[] | null>(null);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Mentioning starts a Round, which needs control: without it there is no picker, only a note.
  const canStartRound = detail.permissions.canControl;
  const activeRound = detail.activeRound;
  // Only Participants that have a name can be written into the text.
  const participants = useMemo(
    () =>
      canStartRound
        ? detail.participants.filter((p): p is typeof p & { name: string } => typeof p.name === "string" && p.name.trim() !== "")
        : [],
    [detail.participants, canStartRound],
  );
  const options = useMemo(() => {
    if (!trigger) return [];
    const needle = trigger.query.toLowerCase();
    return participants.filter((p) => p.name.toLowerCase().includes(needle));
  }, [participants, trigger]);
  const pickerOpen = trigger !== null && options.length > 0;
  const safeIndex = Math.min(activeIndex, Math.max(options.length - 1, 0));

  useLayoutEffect(() => {
    const el = textarea.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  // Another Room (or a Room that closed under us) starts from an empty composer.
  useEffect(() => {
    setDraft("");
    setPicked([]);
    setError(null);
    setIgnored(null);
    setTrigger(null);
    pending.current = null;
  }, [roomId]);

  const refreshTrigger = (text: string, caret: number) => {
    setTrigger(findMentionTrigger(text, caret));
    setActiveIndex(0);
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    refreshTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const choose = (option: { agentId: string; name: string }) => {
    const el = textarea.current;
    if (!trigger || !el) return;
    const caret = el.selectionStart ?? draft.length;
    const next = applyMention(draft, trigger, caret, option.name);
    setDraft(next.text);
    pendingCaret.current = next.caret;
    setPicked((current) =>
      current.some((m) => m.agentId === option.agentId) ? current : [...current, { agentId: option.agentId, name: option.name }],
    );
    setTrigger(null);
    el.focus();
  };

  /** The mentions that are still in the text and still active Participants, in the order picked. */
  const currentMentions = (text: string): string[] => {
    const active = new Set(participants.map((p) => p.agentId.toLowerCase()));
    return picked.filter((m) => active.has(m.agentId.toLowerCase()) && bodyMentions(text, m.name)).map((m) => m.agentId);
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending.current) return;
    const mentions = currentMentions(text);
    // The same text and mentions is a retry of the same send: it keeps its key, so a send that
    // was saved but whose answer was lost is not saved twice.
    const signature = JSON.stringify([text, mentions]);
    if (!pending.current || pending.current.signature !== signature) pending.current = { key: newIdempotencyKey(), signature };
    sending.current = true;
    setBusy(true);
    setError(null);
    setIgnored(null);
    try {
      const response = await client.sendMessage(roomId, { body: text, mentions, idempotencyKey: pending.current.key });
      pending.current = null;
      setDraft("");
      setPicked([]);
      setTrigger(null);
      setIgnored(response.ignoredMentions);
      announceMessagePosted(roomId);
      reloadRoom();
      textarea.current?.focus();
    } catch (cause) {
      const failure = toError(cause);
      setError(failure);
      // A Room closed or a Round started in the meantime (or our rights changed): refetch the Room so the form matches.
      if (["room_closed", "round_active", "round_not_allowed"].includes(String((failure as { code?: unknown }).code))) reloadRoom();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((safeIndex + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((safeIndex - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(options[safeIndex]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const tooLong = draft.trim().length > COMPOSER_BODY_MAX;
  const mentionedNames = picked.filter((m) => currentMentions(draft).includes(m.agentId)).map((m) => m.name);
  const startsRound = mentionedNames.length > 0 && activeRound === null;
  const blockedByRound = mentionedNames.length > 0 && activeRound !== null;
  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <form className="br-stack" onSubmit={onSubmit} noValidate>
      {error ? <ErrorNotice title="Your message was not sent. Your draft is kept." error={error} /> : null}
      <div className="br-field">
        <label className="br-label" htmlFor={fieldId}>
          Message (Markdown)
        </label>
        <textarea
          id={fieldId}
          ref={textarea}
          className="br-input br-composer-input"
          value={draft}
          readOnly={busy}
          rows={4}
          placeholder={canStartRound ? "Write a note. Type @ to mention a Participant." : "Write a note."}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
            }
          }}
          onClick={(event) => refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTrigger(null)}
          aria-invalid={tooLong}
          aria-controls={pickerOpen ? listId : undefined}
          aria-activedescendant={pickerOpen ? optionId(safeIndex) : undefined}
        />
        {pickerOpen ? (
          <ul id={listId} className="br-mention-list" role="listbox" aria-label="Mention a Participant">
            {options.map((option, index) => (
              <li
                key={option.agentId}
                id={optionId(index)}
                role="option"
                aria-selected={index === safeIndex}
                className="br-mention-option"
                data-active={index === safeIndex}
                // mousedown, not click: the textarea would lose focus (and close the list) before a click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
              >
                <span>{option.name}</span>
                {option.role ? <span className="br-muted br-small">{option.role}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {tooLong ? (
          <p className="br-error-text br-small" role="alert">
            The message is longer than {COMPOSER_BODY_MAX.toLocaleString("en-US")} characters.
          </p>
        ) : null}
      </div>

      {canStartRound && !startsRound && !blockedByRound ? (
        <p className="br-muted br-small">Mention a Participant with @ to ask for their reply. That starts a Round.</p>
      ) : null}
      {startsRound ? (
        <p className="br-notice br-notice-warn" role="status">
          Sending will start a Round: {mentionedNames.join(", ")} will reply, one after the other.
        </p>
      ) : null}
      {blockedByRound ? (
        <p className="br-notice br-notice-warn" role="status">
          A Round is already in progress, so this message cannot mention anyone yet. Remove the mentions to post a note, or wait for the Round to finish.
        </p>
      ) : null}

      {ignored && ignored.length > 0 ? (
        <div className="br-notice br-notice-warn br-stack" role="status">
          <p>
            <strong>Your message was posted, but these mentions were ignored:</strong>
          </p>
          <ul className="br-stack">
            {ignored.map((mention) => (
              <li key={mention.agentId}>
                {mention.name ?? `Agent ${shortId(mention.agentId)}`} {IGNORED_REASON_TEXT[mention.reason]}.
              </li>
            ))}
          </ul>
          <div className="br-row">
            <button type="button" className="br-btn" onClick={() => setIgnored(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className="br-footer">
        <span className="br-muted br-small">Ctrl+Enter to send</span>
        <button type="submit" className="br-btn br-btn-primary" disabled={busy || draft.trim() === "" || tooLong || blockedByRound}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
