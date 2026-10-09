import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Host feature detection (one module). Today the only feature is the session cancel,
 * `ctx.agents.sessions.cancelRun(sessionId, companyId, { reason })`, which the SDK this plugin is
 * built with (2026.1005.0) does not have. When the plugin moves to an SDK that includes it, the
 * detection below starts using it and nothing else changes.
 */

/** What a cancel attempt came to: `host` cancelled it, `fallback` means the page must cancel the run, `failed` means the host tried and errored. */
export type SessionCancelOutcome = "host" | "fallback" | "failed";

type CancelRun = (sessionId: string, companyId: string, options: { reason: string }) => Promise<unknown>;

/** The detection result, kept for the life of this worker (one `ctx`), and whether it was logged. */
interface Detection {
  /** `true`: the host has no cancel (no method, or it answered method not found). */
  lacksCancel: boolean;
  logged: boolean;
}
const detections = new WeakMap<object, Detection>();

const METHOD_NOT_FOUND_CODE = -32601;
const METHOD_NOT_FOUND_TEXT = /method not found|not implemented|unknown method|not supported/i;

/** A JSON-RPC "method not found" (code -32601) or "not implemented" error: the host lacks the cancel. */
export function isMethodNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return typeof error === "string" && METHOD_NOT_FOUND_TEXT.test(error);
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === METHOD_NOT_FOUND_CODE) return true;
  return typeof message === "string" && METHOD_NOT_FOUND_TEXT.test(message);
}

function cancelRunOf(ctx: PluginContext): CancelRun | null {
  const sessions = ctx.agents.sessions as unknown as { cancelRun?: unknown };
  return typeof sessions.cancelRun === "function" ? (sessions.cancelRun as CancelRun).bind(sessions) : null;
}

function detectionFor(ctx: PluginContext): Detection {
  let detection = detections.get(ctx);
  if (!detection) {
    detection = { lacksCancel: false, logged: false };
    detections.set(ctx, detection);
  }
  return detection;
}

function logOnce(ctx: PluginContext, detection: Detection, supported: boolean, detail?: string): void {
  if (detection.logged) return;
  detection.logged = true;
  ctx.logger.info(
    supported
      ? "Boardroom: the host can cancel a session's run"
      : "Boardroom: the host cannot cancel a session's run; Stop hands the run id to the page",
    detail ? { detail } : {},
  );
}

/**
 * Ask the host to cancel the run of a session. Returns `host` when the host cancelled, `fallback`
 * when the host has no such call (missing method, or a "method not found" / "not implemented"
 * answer, which is remembered so later Stops skip the call), `failed` for any other error.
 */
export async function cancelSessionRun(
  ctx: PluginContext,
  sessionId: string,
  companyId: string,
  reason: string,
): Promise<SessionCancelOutcome> {
  const detection = detectionFor(ctx);
  const cancelRun = detection.lacksCancel ? null : cancelRunOf(ctx);
  if (!cancelRun) {
    logOnce(ctx, detection, false, "cancelRun is not available");
    return "fallback";
  }
  try {
    await cancelRun(sessionId, companyId, { reason });
    logOnce(ctx, detection, true);
    return "host";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMethodNotFound(error)) {
      detection.lacksCancel = true;
      logOnce(ctx, detection, false, message);
      return "fallback";
    }
    ctx.logger.warn("Boardroom could not cancel a session's run", { sessionId, error: message });
    return "failed";
  }
}
