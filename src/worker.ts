import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    // The spec asks the plugin to record the host and API versions it receives at startup.
    // SDK 2026.1005.0 consumes `instanceInfo.hostVersion` and the host `apiVersion` inside the
    // `initialize` RPC and does not expose them on `ctx`, so log what is available and mark the
    // host version as unknown rather than reaching into SDK internals.
    ctx.logger.info("Boardroom worker started", {
      pluginId: ctx.manifest.id,
      pluginVersion: ctx.manifest.version,
      manifestApiVersion: ctx.manifest.apiVersion,
      databaseNamespace: ctx.db.namespace,
      hostVersion: null,
    });
  },

  async onApiRequest(input) {
    // No route is built yet. Ticket 03 adds the Rooms API.
    return { status: 404, body: { error: `Boardroom route not found: ${input.routeKey}` } };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
