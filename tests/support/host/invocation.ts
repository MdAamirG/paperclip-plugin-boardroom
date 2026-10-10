/**
 * The host's invocation-scope rule for worker-to-host calls, mirrored for tests.
 *
 * Ported from `contextForWorkerMessage` in `server/src/services/plugin-worker-manager.ts` of
 * paperclipai/paperclip. A worker call that names a company is accepted when
 * - it is made inside a host invocation for that company: an API request, a `ctx.events.on`
 *   handler (the invocation is derived from `event.companyId`), an action or a tool; or
 * - the company has a plugin configuration row (a "proactive" scope).
 * Otherwise the host refuses it. Out-of-invocation code is: a session `onEvent` callback, a job
 * handler (job params carry no company), a timer. Boardroom has no settings, so by default a
 * company has no configuration row.
 *
 * Not gated: `ctx.db` (the check does not apply to it in the check run) and calls that name no company.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

interface InvocationScope {
  companyId: string | null;
}

const storage = new AsyncLocalStorage<InvocationScope>();

/** Run `fn` as the host runs a worker invocation for `companyId`. */
export function runInInvocation<T>(companyId: string | null | undefined, fn: () => T): T {
  return storage.run({ companyId: companyId ?? null }, fn);
}

export class InvocationGate {
  /** Companies with a plugin configuration row. */
  readonly configured = new Set<string>();
  /** Every company counts as having a configuration row (for tests that are not about this rule). */
  everyCompanyConfigured = false;

  /**
   * Whether some other invocation is active when an out-of-invocation call arrives. The host then
   * says "missing, expired, or unknown invocation scope"; with none active (the usual case: a quiet
   * session callback, the sweep) it says "company context is required".
   */
  otherInvocationActive = false;

  constructor(private readonly manifest: PaperclipPluginManifestV1) {}

  private check(method: string, companyId: string | null | undefined): void {
    if (!companyId) return;
    const scope = storage.getStore();
    if (scope?.companyId === companyId) return;
    if (!scope && (this.everyCompanyConfigured || this.configured.has(companyId))) return;
    const reason = scope?.companyId
      ? `requested company "${companyId}" but the current invocation is scoped to company "${scope.companyId}"`
      : this.otherInvocationActive
        ? "the worker referenced a missing, expired, or unknown invocation scope"
        : "company context is required";
    // The worker sees a JsonRpcCallError carrying the host's INVOCATION_SCOPE_DENIED code.
    throw Object.assign(new Error(`Plugin "${this.manifest.id}" is not allowed to perform "${method}": ${reason}`), {
      code: -32005,
    });
  }

  /** Wrap the company-scoped calls the plugin uses. Call after every other fake is installed. */
  install(ctx: PluginContext): void {
    const gate = this;
    const { agents, activity, streams } = ctx;
    const sessions = agents.sessions;

    const get = agents.get.bind(agents);
    agents.get = async (agentId, companyId) => (gate.check("agents.get", companyId), get(agentId, companyId));
    const list = agents.list.bind(agents);
    agents.list = async (input) => (gate.check("agents.list", input.companyId), list(input));

    const create = sessions.create.bind(sessions);
    sessions.create = async (agentId, companyId, opts) => (gate.check("agents.sessions.create", companyId), create(agentId, companyId, opts));
    const sendMessage = sessions.sendMessage.bind(sessions);
    sessions.sendMessage = async (sessionId, companyId, opts) => (gate.check("agents.sessions.send", companyId), sendMessage(sessionId, companyId, opts));
    const close = sessions.close.bind(sessions);
    sessions.close = async (sessionId, companyId) => (gate.check("agents.sessions.close", companyId), close(sessionId, companyId));

    const log = activity.log.bind(activity);
    activity.log = async (input) => (gate.check("activity.log", input.companyId), log(input));

    const channelCompany = new Map<string, string>();
    const open = streams.open.bind(streams);
    streams.open = (channel, companyId) => {
      gate.check("streams.open", companyId);
      channelCompany.set(channel, companyId);
      return open(channel, companyId);
    };
    const emit = streams.emit.bind(streams);
    streams.emit = (channel, event) => (gate.check("streams.emit", channelCompany.get(channel) ?? null), emit(channel, event));
  }
}
