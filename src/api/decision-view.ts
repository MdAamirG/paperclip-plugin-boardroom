import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Room } from "../db/index.js";
import type { DecisionView } from "./types.js";

/**
 * The Decision record of a Room as the detail response shows it, or null when there is none.
 *
 * The writer's display name comes from the member lookup. The host's member record carries no
 * name today, so `name` is null unless a future host adds one (`displayName` or `name`); the UI
 * then falls back to "You" or "Board user <short id>". A failed lookup never fails the read.
 */
export async function decisionViewFor(ctx: PluginContext, room: Room): Promise<DecisionView | null> {
  if (!room.decisionMd || !room.decisionByUserId || !room.decisionAt) return null;
  const userId = room.decisionByUserId;
  let name: string | null = null;
  try {
    const members = await ctx.access.members.list({ companyId: room.companyId, includeArchived: true });
    const member = members.find((m) => m.principalType === "user" && m.principalId === userId);
    name = memberName(member);
  } catch (error) {
    ctx.logger.warn("Boardroom could not look up the Decision record writer", {
      roomId: room.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { markdown: room.decisionMd, writer: { userId, name }, at: room.decisionAt };
}

function memberName(member: unknown): string | null {
  if (!member || typeof member !== "object") return null;
  const record = member as { displayName?: unknown; name?: unknown };
  for (const candidate of [record.displayName, record.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}
