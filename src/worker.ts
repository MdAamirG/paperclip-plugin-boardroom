import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { handleApiRequest } from "./api/router.js";
import { registerRecovery } from "./engine/recovery.js";

/** The context from `setup`, which the API handler needs. One worker serves one plugin. */
let workerCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;
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
    registerRecovery(ctx);
  },

  async onApiRequest(input) {
    if (!workerCtx) return { status: 503, body: { error: "not_ready", message: "The Boardroom worker is starting" } };
    return handleApiRequest(workerCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
