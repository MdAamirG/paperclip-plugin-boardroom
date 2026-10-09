import type { PluginApiRouteDeclaration } from "@paperclipai/shared";

/**
 * The full route surface of the plugin API (mounted by the host under
 * `/api/plugins/:pluginId/api`; the plugin key `mdaamirg.boardroom` is accepted as `:pluginId`).
 *
 * Every route is declared here, so later tickets fill in handlers without touching the manifest.
 * A route with no handler in `router.ts` answers 501 `not_implemented`.
 */
type CompanyFrom = "query" | "body" | "issue";

interface RouteSpec {
  routeKey: string;
  method: PluginApiRouteDeclaration["method"];
  path: string;
  /** Where the host finds the company id: GET and DELETE read the query, POST and PATCH the body. */
  company: CompanyFrom;
}

export const ROUTE_SPECS = [
  { routeKey: "rooms.list", method: "GET", path: "/rooms", company: "query" },
  { routeKey: "rooms.create", method: "POST", path: "/rooms", company: "body" },
  { routeKey: "rooms.get", method: "GET", path: "/rooms/:roomId", company: "query" },
  { routeKey: "rooms.update", method: "PATCH", path: "/rooms/:roomId", company: "body" },
  { routeKey: "participants.add", method: "POST", path: "/rooms/:roomId/participants", company: "body" },
  { routeKey: "participants.remove", method: "DELETE", path: "/rooms/:roomId/participants/:agentId", company: "query" },
  { routeKey: "messages.list", method: "GET", path: "/rooms/:roomId/messages", company: "query" },
  { routeKey: "messages.send", method: "POST", path: "/rooms/:roomId/messages", company: "body" },
  { routeKey: "rounds.list", method: "GET", path: "/rooms/:roomId/rounds", company: "query" },
  { routeKey: "costs.get", method: "GET", path: "/rooms/:roomId/costs", company: "query" },
  { routeKey: "rounds.pause", method: "POST", path: "/rooms/:roomId/rounds/:roundId/pause", company: "body" },
  { routeKey: "rounds.resume", method: "POST", path: "/rooms/:roomId/rounds/:roundId/resume", company: "body" },
  { routeKey: "rounds.stop", method: "POST", path: "/rooms/:roomId/rounds/:roundId/stop", company: "body" },
  { routeKey: "rooms.close", method: "POST", path: "/rooms/:roomId/close", company: "body" },
  { routeKey: "decision.update", method: "PATCH", path: "/rooms/:roomId/decision", company: "body" },
  { routeKey: "work.create", method: "POST", path: "/rooms/:roomId/work", company: "body" },
  { routeKey: "work-links.add", method: "POST", path: "/rooms/:roomId/work-links", company: "body" },
  { routeKey: "work-links.remove", method: "DELETE", path: "/rooms/:roomId/work-links/:issueId", company: "query" },
  { routeKey: "issues.rooms", method: "GET", path: "/issues/:issueId/rooms", company: "issue" },
] as const satisfies readonly RouteSpec[];

export type RouteKey = (typeof ROUTE_SPECS)[number]["routeKey"];

/** The `apiRoutes` entries of the manifest. */
export function buildApiRoutes(): PluginApiRouteDeclaration[] {
  return ROUTE_SPECS.map((spec) => ({
    routeKey: spec.routeKey,
    method: spec.method,
    path: spec.path,
    auth: "board" as const,
    capability: "api.routes.register" as const,
    companyResolution:
      spec.company === "issue"
        ? { from: "issue" as const, param: "issueId" }
        : { from: spec.company, key: "companyId" },
  }));
}
