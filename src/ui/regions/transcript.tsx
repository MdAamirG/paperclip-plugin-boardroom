import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownBlock, Spinner, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { MessageView, RoundView, TurnView } from "../../api/types.js";
import { useBoardroomClient, type BoardroomClient } from "../api.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { formatTimestamp, shortId } from "../format.js";
import { toError, useAsyncResource } from "../hooks.js";
import { turnAgentLabel } from "../rounds.js";
import { RegionFrame, type RegionProps } from "./frame.js";
import { onMessagePosted } from "./message-bus.js";

const PAGE_SIZE = 50;
/** Within this distance of the end, a new Message scrolls into view; further up, the reader is left alone. */
const STICK_DISTANCE = 80;
const CATCH_UP_PAGE = 200;
const CATCH_UP_MAX_PAGES = 10;

/** Add `incoming` to `current` by id, keeping the transcript order (older first). */
function mergeMessages(current: MessageView[], incoming: MessageView[], position: "start" | "end"): MessageView[] {
  const known = new Set(current.map((m) => m.id));
  const fresh = incoming.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return current;
  return position === "start" ? [...fresh, ...current] : [...current, ...fresh];
}

interface TranscriptState {
  messages: MessageView[];
  hasEarlier: boolean;
  loading: boolean;
  /** The first load failed: nothing to show. */
  loadError: Error | null;
  /** A refresh after the first load failed: keep showing what we have. */
  refreshError: Error | null;
  earlierError: Error | null;
  loadingEarlier: boolean;
}

/**
 * The Room's transcript: the latest page, "load earlier" pages before it, and catch-up pages
 * after the newest Message whenever the Room changes. Messages are merged by id, so a Message
 * that arrives by two routes (the sender's own signal and the live event) shows once.
 */
function useTranscript(client: BoardroomClient, roomId: string, refreshKey: number) {
  const [state, setState] = useState<TranscriptState>({
    messages: [],
    hasEarlier: false,
    loading: true,
    loadError: null,
    refreshError: null,
    earlierError: null,
    loadingEarlier: false,
  });
  const messagesRef = useRef<MessageView[]>([]);
  const epoch = useRef(0);
  const running = useRef(false);
  const again = useRef(false);

  const commit = useCallback((patch: Partial<TranscriptState>) => {
    if (patch.messages) messagesRef.current = patch.messages;
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const loadLatest = useCallback(async () => {
    const mine = epoch.current;
    try {
      const page = await client.listMessages(roomId, { limit: PAGE_SIZE });
      if (mine !== epoch.current) return;
      commit({ messages: page.messages, hasEarlier: page.hasMore, loading: false, loadError: null, refreshError: null });
    } catch (error) {
      if (mine !== epoch.current) return;
      commit({ loading: false, loadError: messagesRef.current.length === 0 ? toError(error) : null, refreshError: messagesRef.current.length > 0 ? toError(error) : null });
    }
  }, [client, roomId, commit]);

  const catchUpOnce = useCallback(async () => {
    const mine = epoch.current;
    if (messagesRef.current.length === 0) return loadLatest();
    try {
      for (let i = 0; i < CATCH_UP_MAX_PAGES; i += 1) {
        const last = messagesRef.current.at(-1)!;
        const page = await client.listMessages(roomId, { after: last.id, limit: CATCH_UP_PAGE });
        if (mine !== epoch.current) return;
        commit({ messages: mergeMessages(messagesRef.current, page.messages, "end"), refreshError: null });
        if (!page.hasMore || page.messages.length === 0) break;
      }
    } catch (error) {
      if (mine === epoch.current) commit({ refreshError: toError(error) });
    }
  }, [client, roomId, commit, loadLatest]);

  /** Fetch what is new. Calls made while one is running collapse into one more run afterwards. */
  const catchUp = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    const mine = epoch.current;
    try {
      do {
        again.current = false;
        await catchUpOnce();
      } while (again.current && mine === epoch.current);
    } finally {
      if (mine === epoch.current) running.current = false;
    }
  }, [catchUpOnce]);

  // First load, and again for another Room or client.
  useEffect(() => {
    epoch.current += 1;
    running.current = false;
    again.current = false;
    messagesRef.current = [];
    setState({ messages: [], hasEarlier: false, loading: true, loadError: null, refreshError: null, earlierError: null, loadingEarlier: false });
    void loadLatest();
    return () => {
      epoch.current += 1;
    };
  }, [loadLatest]);

  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    firstKey.current = refreshKey;
    void catchUp();
  }, [refreshKey, catchUp]);

  useEffect(() => onMessagePosted(roomId, () => void catchUp()), [roomId, catchUp]);

  const loadEarlier = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first) return;
    const mine = epoch.current;
    commit({ loadingEarlier: true, earlierError: null });
    try {
      const page = await client.listMessages(roomId, { before: first.id, limit: PAGE_SIZE });
      if (mine !== epoch.current) return;
      commit({ messages: mergeMessages(messagesRef.current, page.messages, "start"), hasEarlier: page.hasMore, loadingEarlier: false });
    } catch (error) {
      if (mine === epoch.current) commit({ loadingEarlier: false, earlierError: toError(error) });
    }
  }, [client, roomId, commit]);

  const retry = useCallback(() => {
    if (messagesRef.current.length === 0) {
      commit({ loading: true, loadError: null });
      void loadLatest();
    } else {
      void catchUp();
    }
  }, [commit, loadLatest, catchUp]);

  return { ...state, loadEarlier, retry };
}

/** A finished Turn that left no Message (silent, failed or skipped), shown inline where it ended. */
interface TurnMarker {
  turn: TurnView;
  round: RoundView;
  at: string;
}

const MARKER_TEXT: Record<string, string> = {
  silent: "stayed silent",
  failed: "could not answer (the Turn failed)",
  skipped: "was skipped",
};

/**
 * The markers to show among the loaded Messages. A marker goes after the last Message that is
 * not newer than the Turn's end. One that ended before the oldest loaded Message is left out
 * until the earlier Messages are loaded, so it never floats above its context.
 */
function turnMarkers(rounds: readonly RoundView[], messages: readonly MessageView[], hasEarlier: boolean): TurnMarker[] {
  const oldest = messages[0]?.createdAt;
  const markers: TurnMarker[] = [];
  for (const round of rounds) {
    for (const turn of round.turns) {
      if (turn.status !== "finished" || !turn.finishedAt || turn.outcome === "posted" || turn.outcome === null) continue;
      if (hasEarlier && oldest !== undefined && Date.parse(turn.finishedAt) < Date.parse(oldest)) continue;
      markers.push({ turn, round, at: turn.finishedAt });
    }
  }
  return markers.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

type TranscriptItem = { kind: "message"; message: MessageView } | { kind: "marker"; marker: TurnMarker };

/** Merge Messages and markers by time; a Message wins a tie, so a marker never precedes the Message it follows. */
function interleave(messages: readonly MessageView[], markers: readonly TurnMarker[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let next = 0;
  for (const message of messages) {
    while (next < markers.length && Date.parse(markers[next]!.at) < Date.parse(message.createdAt)) {
      items.push({ kind: "marker", marker: markers[next]! });
      next += 1;
    }
    items.push({ kind: "message", message });
  }
  while (next < markers.length) {
    items.push({ kind: "marker", marker: markers[next]! });
    next += 1;
  }
  return items;
}

/** Who wrote a Message, as shown on its label. */
function authorLabel(message: MessageView, currentUserId: string | null | undefined): string {
  if (message.authorKind === "agent") return message.authorName ?? `Removed agent (${shortId(message.authorId)})`;
  if (currentUserId && message.authorId === currentUserId) return "You";
  if (message.authorName) return message.authorName;
  return message.authorId === "local-board" ? "Board" : `Board user ${shortId(message.authorId)}`;
}

function MessageArticle({ message, userId, activeAgentIds }: { message: MessageView; userId: string | null | undefined; activeAgentIds: ReadonlySet<string> }) {
  return (
    <article className="br-message" data-message-id={message.id} data-author-kind={message.authorKind}>
      <header className="br-message-head">
        <strong>{authorLabel(message, userId)}</strong>
        {message.authorKind === "agent" ? (
          <span className="br-muted br-small">
            agent{activeAgentIds.has(message.authorId.toLowerCase()) ? "" : " · no longer in this Room"}
          </span>
        ) : null}
        <time className="br-muted br-small" dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt)}
        </time>
      </header>
      <MarkdownBlock content={message.body} />
    </article>
  );
}

export function TranscriptRegion({ companyId, detail, refreshKey }: RegionProps) {
  const roomId = detail.room.id;
  const client = useBoardroomClient(companyId);
  const { userId } = useHostContext();
  const transcript = useTranscript(client, roomId, refreshKey);
  const rounds = useAsyncResource(() => client.listRounds(roomId), [client, roomId], refreshKey);
  const items = useMemo(
    () => interleave(transcript.messages, turnMarkers(rounds.data?.rounds ?? [], transcript.messages, transcript.hasEarlier)),
    [transcript.messages, transcript.hasEarlier, rounds.data],
  );
  const activeAgentIds = useMemo(() => new Set(detail.participants.map((p) => p.agentId.toLowerCase())), [detail.participants]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const stuckToEnd = useRef(true);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const lastSeenId = useRef<string | null>(null);

  const loadEarlier = () => {
    const el = scroller.current;
    if (el) prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void transcript.loadEarlier();
  };

  const newestId = transcript.messages.at(-1)?.id ?? null;
  const oldestId = transcript.messages[0]?.id ?? null;

  // Keep the reader's place when older Messages are added above, and follow the newest Message
  // when the reader is at the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const anchor = prependAnchor.current;
    if (anchor && newestId === lastSeenId.current) {
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      prependAnchor.current = null;
      return;
    }
    prependAnchor.current = null;
    if (newestId !== lastSeenId.current) {
      lastSeenId.current = newestId;
      if (stuckToEnd.current) el.scrollTop = el.scrollHeight;
    }
  }, [newestId, oldestId, transcript.loading]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stuckToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_DISTANCE;
  };

  return (
    <RegionFrame region="transcript" title="Transcript">
      {transcript.loading ? (
        <p className="br-row" aria-live="polite">
          <Spinner size="sm" label="Loading the transcript" />
          <span className="br-muted">Loading the transcript…</span>
        </p>
      ) : transcript.loadError ? (
        <ErrorNotice title="Could not load the transcript" error={transcript.loadError} onRetry={transcript.retry} />
      ) : (
        <>
          {transcript.refreshError ? (
            <ErrorNotice title="Could not refresh the transcript" error={transcript.refreshError} onRetry={transcript.retry} />
          ) : null}
          {rounds.error ? <ErrorNotice title="Could not load the Turn markers" error={rounds.error} onRetry={rounds.reload} /> : null}
          <div ref={scroller} onScroll={onScroll} className="br-transcript" role="log" aria-label="Transcript" tabIndex={0}>
            {transcript.hasEarlier ? (
              <div className="br-stack">
                {transcript.earlierError ? (
                  <ErrorNotice title="Could not load earlier messages" error={transcript.earlierError} />
                ) : null}
                <button type="button" className="br-btn" onClick={loadEarlier} disabled={transcript.loadingEarlier}>
                  {transcript.loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
                </button>
              </div>
            ) : null}
            {transcript.messages.length === 0 ? (
              <p className="br-muted">No messages yet.</p>
            ) : (
              items.map((item) =>
                item.kind === "marker" ? (
                  <p
                    key={`turn-${item.marker.turn.id}`}
                    className="br-turn-marker"
                    role="status"
                    data-turn-id={item.marker.turn.id}
                    data-turn-outcome={item.marker.turn.outcome ?? ""}
                  >
                    <strong>{turnAgentLabel(item.marker.turn)}</strong>{" "}
                    <span>{MARKER_TEXT[item.marker.turn.outcome ?? ""] ?? "finished"}</span>
                    {item.marker.turn.outcome === "failed" && item.marker.turn.hostMessage ? (
                      <span className="br-small">{item.marker.turn.hostMessage}</span>
                    ) : null}
                  </p>
                ) : (
                  <MessageArticle key={item.message.id} message={item.message} userId={userId} activeAgentIds={activeAgentIds} />
                ),
              )
            )}
          </div>
        </>
      )}
    </RegionFrame>
  );
}
