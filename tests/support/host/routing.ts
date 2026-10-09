/**
 * The host's scoped plugin API route, `/api/plugins/:pluginId/api/*`, mirrored for tests.
 *
 * Ported from `server/src/routes/plugins.ts` and `server/src/routes/authz.ts` in
 * paperclipai/paperclip (MIT), as shipped with host release 2026.1005.0. Same order and statuses:
 *
 * 1. 404 when the manifest lacks `api.routes.register`, or no `apiRoutes` entry matches the
 *    method and path. The worker is not called.
 * 2. The route's `auth` (`board`: 403 "Board access required" for anyone else).
 * 3. Company resolution (`companyResolution` from body, query or an issue param); 400 when none.
 * 4. `assertCompanyAccess`: 403 for a user without membership, a viewer's non-GET, or an agent
 *    of another company.
 * 5. 415 for a non-JSON body, 413 for a body over 1 MB.
 * 6. The worker's `onApiRequest`. A thrown error crosses the RPC as its message and numeric code
 *    only: capability denied → 403, method not implemented → 501, anything else → 502. A missing
 *    or malformed result fails in the host → 500.
 */
import type { PaperclipPlugin, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk/protocol";
import type { PaperclipPluginManifestV1, PluginApiRouteDeclaration } from "@paperclipai/shared";
import { HostHttpError, viaJson } from "./errors.js";
import { runInInvocation } from "./invocation.js";
import type { HostRecords } from "./records.js";
import type { SeededAgent, SeededMember } from "./seeding.js";

const BODY_LIMIT_BYTES = 1_000_000;
const SAFE_REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent", "x-paperclip-run-id", "x-request-id"]);
const RESPONSE_HEADER_ALLOWLIST = new Set(["cache-control", "etag", "last-modified", "x-request-id"]);

/** The plugin-facing actor the host passes for the local board user (local trusted mode). */
export const BOARD_ACTOR: PluginApiRequestInput["actor"] = Object.freeze({
  actorType: "user",
  actorId: "local-board",
  userId: "local-board",
  agentId: null,
  runId: null,
});

/**
 * Who makes a request:
 * - omitted: the local board user (`local_implicit`, access to every company);
 * - a seeded member (`{ userId }`) or a host-shaped user actor: a signed-in board user whose
 *   company access comes from the seeded memberships;
 * - a seeded agent, or a host-shaped agent actor: an agent key of the agent's company;
 * - `"anonymous"`: no actor.
 */
export type ActorInput =
  | PluginApiRequestInput["actor"]
  | Pick<SeededMember, "userId">
  | (Pick<SeededAgent, "id" | "companyId"> & { runId?: string | null })
  | "anonymous";

export interface RequestOptions {
  query?: Record<string, string | string[]>;
  body?: unknown;
  /** Defaults to the local board user. */
  actor?: ActorInput;
  headers?: Record<string, string>;
}

export interface HarnessResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

/** The host's `req.actor`, reduced to what the plugin route reads. */
type HostActor =
  | { type: "none" }
  | {
      type: "board";
      userId: string;
      source: "local_implicit" | "session";
      companyIds: string[];
      memberships: Array<{ companyId: string; status: string; membershipRole: string | null }>;
    }
  | { type: "agent"; agentId: string; companyId: string | null; runId: string | null };

function boardUser(userId: string, records: HostRecords): HostActor {
  if (userId === BOARD_ACTOR.userId) {
    return { type: "board", userId, source: "local_implicit", companyIds: [], memberships: [] };
  }
  const memberships = records.accessMembers
    .filter((m) => m.principalType === "user" && m.principalId === userId)
    .map((m) => ({ companyId: m.companyId, status: m.status, membershipRole: m.membershipRole ?? null }));
  const companyIds = memberships.filter((m) => m.status === "active").map((m) => m.companyId);
  return { type: "board", userId, source: "session", companyIds, memberships };
}

function toHostActor(actor: ActorInput | undefined, records: HostRecords): HostActor {
  if (actor === undefined) return boardUser(BOARD_ACTOR.userId!, records);
  if (actor === "anonymous") return { type: "none" };
  if ("actorType" in actor) {
    if (actor.actorType === "user") return boardUser(actor.userId ?? actor.actorId, records);
    const agentId = actor.agentId ?? actor.actorId;
    return { type: "agent", agentId, companyId: records.agents.get(agentId)?.companyId ?? null, runId: actor.runId ?? null };
  }
  if ("userId" in actor) return boardUser(actor.userId, records);
  return { type: "agent", agentId: actor.id, companyId: actor.companyId, runId: actor.runId ?? null };
}

function toPluginActor(actor: Exclude<HostActor, { type: "none" }>): PluginApiRequestInput["actor"] {
  if (actor.type === "board") {
    return { actorType: "user", actorId: actor.userId, userId: actor.userId, agentId: null, runId: null };
  }
  return { actorType: "agent", actorId: actor.agentId, userId: null, agentId: actor.agentId, runId: actor.runId };
}

function matchRoute(route: PluginApiRouteDeclaration, method: string, requestPath: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const normalize = (value: string) => value.replace(/\/+$/, "") || "/";
  const routeSegments = normalize(route.path).split("/").filter(Boolean);
  const requestSegments = normalize(requestPath).split("/").filter(Boolean);
  if (routeSegments.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSegment = routeSegments[i]!;
    const requestSegment = requestSegments[i]!;
    if (routeSegment.startsWith(":")) {
      params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
      continue;
    }
    if (routeSegment !== requestSegment) return null;
  }
  return params;
}

function assertRouteAuth(actor: HostActor, route: PluginApiRouteDeclaration): void {
  if (route.auth === "board") {
    if (actor.type !== "board") throw new HostHttpError(403, "Board access required");
    return;
  }
  if (route.auth === "agent") {
    if (actor.type === "none") throw new HostHttpError(401, "Unauthorized");
    if (actor.type !== "agent") throw new HostHttpError(403, "Agent access required");
    return;
  }
  if (route.auth === "webhook") {
    throw new HostHttpError(422, "Webhook-scoped plugin API routes require a signature verifier and are not enabled");
  }
  if (actor.type === "none") throw new HostHttpError(401, "Unauthorized");
}

function resolveCompanyId(
  route: PluginApiRouteDeclaration,
  params: Record<string, string>,
  actor: HostActor,
  options: RequestOptions,
  records: HostRecords,
): string | null {
  const resolution = route.companyResolution;
  if (!resolution) return actor.type === "agent" ? actor.companyId : null;
  if (resolution.from === "body") {
    const value = (options.body as Record<string, unknown> | null | undefined)?.[resolution.key];
    return typeof value === "string" ? value : null;
  }
  if (resolution.from === "query") {
    const value = options.query?.[resolution.key];
    return typeof value === "string" ? value : null;
  }
  const issueId = params[resolution.param];
  return issueId ? records.companyOfIssue(issueId) : null;
}

function assertCompanyAccess(actor: HostActor, companyId: string, method: string): void {
  if (actor.type === "none") throw new HostHttpError(401, "Unauthorized");
  if (actor.type === "agent" && actor.companyId !== companyId) {
    throw new HostHttpError(403, "Agent key cannot access another company");
  }
  if (actor.type === "board" && actor.source !== "local_implicit") {
    if (!actor.companyIds.includes(companyId)) throw new HostHttpError(403, "User does not have access to this company");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const membership = actor.memberships.find((m) => m.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw new HostHttpError(403, "User does not have active company access");
      }
      if (membership.membershipRole === "viewer") throw new HostHttpError(403, "Viewer access is read-only");
    }
  }
}

/** An error from the worker as the host receives it: a message and a JSON-RPC code. */
class WorkerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function asWorkerError(error: unknown): WorkerRpcError {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return new WorkerRpcError(message, code);
  // The SDK harness's own capability check throws a plain Error; the host's carries the code.
  if (/is missing required capability/.test(message)) {
    return new WorkerRpcError(message, PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED);
  }
  return new WorkerRpcError(message, PLUGIN_RPC_ERROR_CODES.WORKER_ERROR);
}

function statusForError(error: unknown): number {
  if (error instanceof HostHttpError) return error.status;
  if (error instanceof WorkerRpcError) {
    if (
      error.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED ||
      error.code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
    ) {
      return 403;
    }
    return error.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED ? 501 : 502;
  }
  return 500;
}

function sanitizeHeaders(headers: Record<string, string>, allowed: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (allowed.has(lower)) out[lower] = value;
  }
  return out;
}

export async function dispatchApiRequest<T>(
  host: { manifest: PaperclipPluginManifestV1; plugin: PaperclipPlugin; records: HostRecords },
  method: string,
  requestPath: string,
  options: RequestOptions = {},
): Promise<HarnessResponse<T>> {
  const { manifest, plugin, records } = host;
  const fail = (status: number, error: string) => ({ status, headers: {}, body: { error } as T });

  if (!(manifest.capabilities as readonly string[]).includes("api.routes.register")) {
    return fail(404, "Plugin does not expose scoped API routes");
  }
  const match = (manifest.apiRoutes ?? [])
    .map((route) => ({ route, params: matchRoute(route, method, requestPath) }))
    .find((candidate) => candidate.params !== null);
  if (!match || !match.params) return fail(404, "Plugin API route not found");

  const actor = toHostActor(options.actor, records);
  // Header names are case-insensitive: a caller's "Content-Type" replaces the default.
  const requestHeaders: Record<string, string> = {
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
  };
  try {
    assertRouteAuth(actor, match.route);
    const companyId = resolveCompanyId(match.route, match.params, actor, options, records);
    if (!companyId) return fail(400, "Unable to resolve company for plugin API route");
    assertCompanyAccess(actor, companyId, method);
    if ((match.route.checkoutPolicy ?? "none") !== "none" && actor.type === "agent") {
      throw new Error("The harness does not simulate checkout-protected plugin API routes");
    }
    const contentType = requestHeaders["content-type"];
    if (method !== "GET" && contentType && !/^application\/json\b/i.test(contentType)) {
      return fail(415, "Plugin API routes accept JSON requests only");
    }
    const body = viaJson(options.body ?? null);
    if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT_BYTES) return fail(413, "Plugin API request body is too large");

    const input: PluginApiRequestInput = {
      routeKey: match.route.routeKey,
      method,
      path: requestPath,
      params: match.params,
      query: options.query ?? {},
      body,
      actor: toPluginActor(actor as Exclude<HostActor, { type: "none" }>),
      companyId,
      headers: sanitizeHeaders(requestHeaders, SAFE_REQUEST_HEADERS),
    };

    let result: unknown;
    try {
      const handler = plugin.definition.onApiRequest;
      if (!handler) {
        throw Object.assign(new Error("handleApiRequest is not implemented by this plugin"), {
          code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
        });
      }
      // The worker sends `result ?? null`.
      result = viaJson(await runInInvocation(companyId, () => handler(viaJson(input)))) ?? null;
    } catch (error) {
      throw asWorkerError(error);
    }

    // As in the host: a null result throws here (TypeError), which the route answers with 500.
    const response = result as { status?: unknown; headers?: Record<string, string>; body?: unknown };
    const status =
      Number.isInteger(response.status) && Number(response.status) >= 200 && Number(response.status) <= 599
        ? Number(response.status)
        : 200;
    return {
      status,
      headers: sanitizeHeaders(response.headers ?? {}, RESPONSE_HEADER_ALLOWLIST),
      body: (status === 204 ? null : (response.body ?? null)) as T,
    };
  } catch (error) {
    return fail(statusForError(error), error instanceof Error ? error.message : String(error));
  }
}
