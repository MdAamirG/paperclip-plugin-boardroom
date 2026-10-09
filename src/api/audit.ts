import type { PluginContext } from "@paperclipai/plugin-sdk";

export const ROOM_ENTITY_TYPE = "boardroom_room";

export interface AuditEntry {
  companyId: string;
  /** The human who acted. In 0.x the entry is attributed to the plugin and this goes in the metadata. */
  actingUserId: string;
  roomId: string;
  /** Short, stable text such as "Room created". Details go in `metadata`. */
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * The one place that writes activity entries. The later release switches to host-attributed
 * entries (`actorUserId`) by changing only this function.
 *
 * A failed audit write is logged and does not fail the request: the mutation is already
 * committed, and a retry would repeat it.
 */
export async function audit(ctx: PluginContext, entry: AuditEntry): Promise<void> {
  try {
    await ctx.activity.log({
      companyId: entry.companyId,
      message: entry.message,
      entityType: ROOM_ENTITY_TYPE,
      entityId: entry.roomId,
      metadata: { ...entry.metadata, actingUserId: entry.actingUserId, roomId: entry.roomId },
    });
  } catch (error) {
    ctx.logger.error("Boardroom could not write an activity entry", {
      message: entry.message,
      roomId: entry.roomId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
