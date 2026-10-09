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

/** Says live updates are off, without hiding the page. */
export function LiveUpdatesNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="status" className="br-notice br-notice-warn br-small">
      Live updates are off ({error.message}). Reload the page to reconnect.
    </p>
  );
}
