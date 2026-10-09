import type { PluginContext } from "@paperclipai/plugin-sdk";
import { touchRoom } from "../db/index.js";

/**
 * Bump `rooms.updated_at` after a committed write (nothing in the database does it). A failure is
 * logged, not thrown: the write is already committed and a retry would repeat it.
 */
export async function touchRoomSafely(ctx: PluginContext, companyId: string, roomId: string): Promise<void> {
  try {
    await touchRoom(ctx.db, companyId, roomId);
  } catch (error) {
    ctx.logger.warn("Boardroom could not mark a Room as updated", {
      roomId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
