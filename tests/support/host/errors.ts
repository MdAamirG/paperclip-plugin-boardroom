/**
 * Host error shapes the harness reproduces.
 *
 * - `HostHttpError`: the host route layer's `HttpError` (status + message), e.g. from
 *   `assertBoard` or `assertCompanyAccess`. The scoped API route answers `{ error: message }`.
 * - `capabilityDenied`: the host's `CapabilityDeniedError`. Its JSON-RPC code
 *   (`CAPABILITY_DENIED`) crosses the worker RPC, so the scoped API route answers 403.
 */
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk/protocol";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export class HostHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function capabilityDenied(pluginId: string, method: string, capability: string): Error & { code: number } {
  return Object.assign(
    new Error(`Plugin "${pluginId}" is missing required capability "${capability}" for method "${method}"`),
    { code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED },
  );
}

/** Throw the host's capability error when the manifest does not declare `capability`. */
export function requireCapability(manifest: PaperclipPluginManifestV1, method: string, capability: string): void {
  if (!(manifest.capabilities as readonly string[]).includes(capability)) {
    throw capabilityDenied(manifest.id, method, capability);
  }
}

/** Everything crossing the worker RPC is JSON: Dates become ISO strings, undefined disappears. */
export function viaJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
