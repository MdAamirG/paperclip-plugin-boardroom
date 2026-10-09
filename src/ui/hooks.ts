import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { BOARDROOM_STREAM_CHANNEL, type RoomChangedEvent } from "../api/live.js";

export interface Resource<T> {
  data: T | null;
  /** The last failure, kept next to the previous data when only a refetch failed. */
  error: Error | null;
  /** True until the first answer for the current inputs. A refetch does not set it. */
  loading: boolean;
  /** Fetch again without clearing what is shown. */
  reload: () => void;
}

/**
 * Load a value when `deps` change and again on `reload()` or when `refreshKey` changes.
 * Out-of-order answers are dropped. A failed refetch keeps the old data and reports the error.
 */
export function useAsyncResource<T>(load: () => Promise<T>, deps: readonly unknown[], refreshKey = 0): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const sequence = useRef(0);

  const run = useCallback(async (initial: boolean) => {
    const id = ++sequence.current;
    if (initial) setState({ data: null, error: null, loading: true });
    try {
      const data = await loadRef.current();
      if (id === sequence.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === sequence.current) {
        setState((current) => ({ data: initial ? null : current.data, error: toError(error), loading: false }));
      }
    }
  }, []);

  useEffect(() => {
    void run(true);
    return () => {
      sequence.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    firstKey.current = refreshKey;
    void run(false);
  }, [refreshKey, run]);

  const reload = useCallback(() => {
    void run(false);
  }, [run]);

  return { ...state, reload };
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface LiveRooms {
  /** Goes up by one each time a `room.changed` event arrives that matters to the caller. */
  tick: number;
  /** Set when the stream could not connect or dropped, so the page can say live updates are off. */
  streamError: Error | null;
}

/**
 * Subscribe to the company's `boardroom` stream. With a `roomId`, only events for that Room count
 * (the Room page); with `null`, any Room counts (the list). The host's hook keeps every event it
 * has received, so this reads only the new ones, and it starts over when the host resets the list
 * (a reconnect).
 */
export function useRoomChanged(companyId: string, roomId: string | null): LiveRooms {
  const { events, error } = usePluginStream<RoomChangedEvent>(BOARDROOM_STREAM_CHANNEL, { companyId });
  const [tick, setTick] = useState(0);
  const seen = useRef(0);

  useEffect(() => {
    if (events.length < seen.current) seen.current = 0;
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    const relevant = fresh.some(
      (event) =>
        event?.type === "room.changed" &&
        (event.companyId === undefined || event.companyId === companyId) &&
        (roomId === null || event.roomId === roomId),
    );
    if (relevant) setTick((value) => value + 1);
  }, [events, companyId, roomId]);

  return { tick, streamError: error };
}

/** How often the page refetches when the live stream is off: while a Round is active, and otherwise. */
export const POLL_ACTIVE_MS = 5_000;
export const POLL_IDLE_MS = 30_000;

export interface StreamFallbackPoll {
  /** Goes up by one on each poll; add it to the live tick to refetch. */
  tick: number;
  /** The interval in use, or null when not polling (stream on, or the page hidden). */
  intervalMs: number | null;
}

function pageIsVisible(): boolean {
  try {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  } catch {
    return true;
  }
}

/**
 * Keep the page fresh when the live stream is off (the host answers 501 when its stream bridge is
 * not enabled, or the connection dropped). Polls every `POLL_ACTIVE_MS` while a Round is active and
 * every `POLL_IDLE_MS` otherwise, stops while the page is hidden and refetches once when it is shown
 * again. Does nothing while the stream works.
 */
export function useStreamFallbackPoll(streamOff: boolean, roundActive: boolean): StreamFallbackPoll {
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(pageIsVisible);

  useEffect(() => {
    if (!streamOff || typeof document === "undefined") return;
    const onChange = () => {
      const now = pageIsVisible();
      setVisible(now);
      if (now) setTick((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [streamOff]);

  const intervalMs = streamOff && visible ? (roundActive ? POLL_ACTIVE_MS : POLL_IDLE_MS) : null;
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return { tick, intervalMs };
}
