/**
 * A spy for `ctx.streams`: records every emit with the company its channel was opened for.
 * The host drops events on a channel that was never opened; `companyId` is `null` for those.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { viaJson } from "./errors.js";

export interface StreamEventRecord {
  channel: string;
  /** Company the channel was opened for; `null` when emitted without `open` (the host drops those). */
  companyId: string | null;
  event: unknown;
}

export function installStreams(ctx: PluginContext, events: StreamEventRecord[]): void {
  const channelCompany = new Map<string, string>();
  ctx.streams = {
    open(channel, companyId) {
      channelCompany.set(channel, companyId);
    },
    emit(channel, event) {
      events.push({ channel, companyId: channelCompany.get(channel) ?? null, event: viaJson(event) });
    },
    close(channel) {
      channelCompany.delete(channel);
    },
  };
}
