/** A failed load or mutation, with the server's text. `role="alert"` so assistive tech announces it. */
export function ErrorNotice({ title, error, onRetry }: { title: string; error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="br-notice br-notice-error br-stack">
      <p>
        <strong>{title}</strong>
      </p>
      <p>{error.message}</p>
      {onRetry ? (
        <div className="br-row">
          <button type="button" className="br-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A small, honest status when the live stream is off. The page then refreshes itself on a timer
 * (`intervalMs`), so this is information, not a dead end; while the page is hidden the timer is
 * stopped and `intervalMs` is null.
 */
export function LiveUpdatesNotice({ error, intervalMs }: { error: Error | null; intervalMs?: number | null }) {
  if (!error) return null;
  const every = intervalMs ? ` and checks for changes every ${Math.round(intervalMs / 1000)} seconds` : "";
  return (
    <p role="status" className="br-muted br-small" data-testid="live-updates-notice">
      Live updates are off ({error.message}). This page refreshes itself{every}.
    </p>
  );
}
