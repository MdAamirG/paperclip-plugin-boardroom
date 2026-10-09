import { getRoom, listWorkLinksForIssue } from "../db/index.js";
import { requireLevel } from "./access.js";
import type { RouteHandler } from "./context.js";
import { ok } from "./errors.js";
import type { IssueRoomsResponse, IssueRoomView } from "./types.js";

/**
 * `GET /issues/:issueId/rooms`: the Rooms of the issue's company that have a work link for the issue,
 * oldest link first (the "From Room" chip). The host resolves the company from the issue; every read
 * here is filtered by that company, so another company's Room can never come back. It reads
 * `work_links` only, never the issue's origin, so a `linked` task shows the chip too. An unknown issue
 * (or one that is in no Room) is an empty list.
 */
export const listRoomsForIssue: RouteHandler = async ({ ctx, input, actor }) => {
  requireLevel(actor, "read");
  const links = await listWorkLinksForIssue(ctx.db, input.companyId, input.params.issueId ?? "");
  const rooms: IssueRoomView[] = [];
  for (const link of links) {
    const room = await getRoom(ctx.db, input.companyId, link.roomId);
    if (!room) continue;
    rooms.push({ roomId: room.id, title: room.title, status: room.status, relation: link.relation });
  }
  return ok<IssueRoomsResponse>({ rooms });
};
