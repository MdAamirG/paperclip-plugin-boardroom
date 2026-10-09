import { BOARDROOM_ROUTE_PATH } from "../constants.js";

/** Where the Boardroom page is: the list, the creation flow, one Room, or an address that matches none. */
export type BoardroomRoute =
  | { name: "list" }
  | { name: "new" }
  | { name: "room"; roomId: string }
  | { name: "unknown"; path: string };

/** Company-relative paths for `useHostNavigation` (the host adds the company prefix). */
export const boardroomPaths = {
  list: () => `/${BOARDROOM_ROUTE_PATH}`,
  create: () => `/${BOARDROOM_ROUTE_PATH}/new`,
  room: (roomId: string) => `/${BOARDROOM_ROUTE_PATH}/${encodeURIComponent(roomId)}`,
};

/**
 * Read the page route from the host location (`/:companyPrefix/boardroom[/new|/:roomId]`). The
 * company prefix is the first segment; it is skipped by position (not by name), so a company whose
 * prefix is "boardroom" still works.
 */
export function parseBoardroomRoute(pathname: string, companyPrefix: string | null): BoardroomRoute {
  const segments = pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
  const first = segments[0];
  const hasPrefix = companyPrefix !== null && first !== undefined && first.toLowerCase() === companyPrefix.toLowerCase();
  const rest = hasPrefix ? segments.slice(1) : segments;
  if (rest[0] !== BOARDROOM_ROUTE_PATH) return { name: "unknown", path: pathname };
  const [, sub, extra] = rest;
  if (extra !== undefined) return { name: "unknown", path: pathname };
  if (sub === undefined) return { name: "list" };
  if (sub === "new") return { name: "new" };
  return { name: "room", roomId: sub };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
