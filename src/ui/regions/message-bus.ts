/**
 * A tiny in-page signal from the composer to the transcript: "a Message was just saved in this
 * Room, fetch the newest ones now". The live `room.changed` event does the same for other tabs,
 * but it may be late or off, and a sender should see their own Message at once.
 */
type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

export function onMessagePosted(roomId: string, listener: Listener): () => void {
  const set = listeners.get(roomId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(roomId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(roomId);
  };
}

export function announceMessagePosted(roomId: string): void {
  for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
}
