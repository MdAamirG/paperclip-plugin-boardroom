import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { RoomMessage } from "../db/index.js";
import type { MessageView } from "./types.js";
import { isUuid } from "./validation.js";

/**
 * Messages with their author's name. Agent names come from `ctx.agents` (one lookup per agent,
 * even if the agent was removed from the Room, so attribution survives removal); a failed lookup
 * or a deleted agent gives `null`. User names are `null` (the SDK has no user name lookup).
 */
export async function toMessageViews(ctx: PluginContext, companyId: string, messages: readonly RoomMessage[]): Promise<MessageView[]> {
  const agentIds = [...new Set(messages.filter((m) => m.authorKind === "agent").map((m) => m.authorId))];
  const names = new Map<string, string | null>();
  await Promise.all(
    agentIds.map(async (agentId) => {
      if (!isUuid(agentId)) return names.set(agentId, null);
      try {
        names.set(agentId, (await ctx.agents.get(agentId, companyId))?.name ?? null);
      } catch (error) {
        ctx.logger.warn("Boardroom could not look up an agent name", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        names.set(agentId, null);
      }
    }),
  );
  return messages.map((m) => ({
    id: m.id,
    roomId: m.roomId,
    authorKind: m.authorKind,
    authorId: m.authorId,
    authorName: m.authorKind === "agent" ? (names.get(m.authorId) ?? null) : null,
    body: m.body,
    createdAt: m.createdAt,
    roundId: m.roundId,
    turnId: m.turnId,
    runId: m.runId,
  }));
}
