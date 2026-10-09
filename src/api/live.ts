import type { PluginContext } from "@paperclipai/plugin-sdk";
import { touchRoom } from "../db/index.js";

/** The single stream channel; the UI subscribes with its company id. */
export const BOARDROOM_STREAM_CHANNEL = "boardroom";

export interface RoomChangedEvent {
  type: "room.changed";
  roomId: string;
  companyId: string;
}

/**
 * Announce that a Room changed. Call once after every committed mutation.
 *
 * The SDK keeps one company per channel name (the last `open`), so the channel is opened for this
 * company right before each emit. The two calls are synchronous, so another request cannot
 * interleave and send the event to the wrong company.
 */
export function announceRoomChanged(ctx: PluginContext, companyId: string, roomId: string): void {
  const event: RoomChangedEvent = { type: "room.changed", roomId, companyId };
  try {
    ctx.streams.open(BOARDROOM_STREAM_CHANNEL, companyId);
    ctx.streams.emit(BOARDROOM_STREAM_CHANNEL, event);
  } catch (error) {
    ctx.logger.warn("Boardroom could not publish a live update", {
      roomId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
