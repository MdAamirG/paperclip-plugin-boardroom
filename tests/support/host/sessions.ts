/**
 * A host-like fake for `ctx.agents.sessions`: records every send, inserts a queued
 * `heartbeat_runs` row per successful send (as the host's wakeup does), can be told to fail
 * sends, and keeps sessions across a plugin restart (they are host records).
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { AgentSession, AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import type { Agent, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { requireCapability, viaJson } from "./errors.js";

export interface SessionSendRecord {
  sessionId: string;
  agentId: string;
  companyId: string;
  prompt: string;
  reason: string | null;
  /** Set when the send succeeded. */
  runId: string | null;
  /** Set when the send was made to fail. */
  error: string | null;
}

export class SessionHost {
  /** Every `sendMessage` call, oldest first, failed ones included. */
  readonly sends: SessionSendRecord[] = [];
  private readonly sessions = new Map<string, AgentSession>();
  private readonly oneShotFailures: Error[] = [];
  private readonly failureRules: Array<{
    predicate: (send: SessionSendRecord) => boolean;
    makeError: (send: SessionSendRecord) => Error;
  }> = [];
  /** Event callbacks are plugin memory: replaced on every start. */
  private callbacks = new Map<string, (event: AgentSessionEvent) => void>();

  constructor(
    private readonly pg: PGlite,
    private readonly manifest: PaperclipPluginManifestV1,
    private readonly agents: ReadonlyMap<string, Agent>,
  ) {}

  failNext(error: Error): void {
    this.oneShotFailures.push(error);
  }

  failWhen(predicate: (send: SessionSendRecord) => boolean, makeError: (send: SessionSendRecord) => Error): void {
    this.failureRules.push({ predicate, makeError });
  }

  clearFailures(): void {
    this.oneShotFailures.length = 0;
    this.failureRules.length = 0;
  }

  simulateEvent(sessionId: string, event: Omit<AgentSessionEvent, "sessionId">): void {
    const callback = this.callbacks.get(sessionId);
    if (!callback) throw new Error(`No active session event callback for session: ${sessionId}`);
    callback(viaJson({ ...event, sessionId }));
  }

  /** Install the fake on a new plugin context; drops the previous start's callbacks. */
  install(ctx: PluginContext): void {
    this.callbacks = new Map();
    const callbacks = this.callbacks;
    const { manifest, agents, sessions, pg } = this;
    ctx.agents.sessions = {
      create: async (agentId, companyId) => {
        requireCapability(manifest, "agents.sessions.create", "agent.sessions.create");
        const agent = agents.get(agentId);
        if (!companyId || !agent || agent.companyId !== companyId) throw new Error(`Agent not found: ${agentId}`);
        const session: AgentSession = {
          sessionId: randomUUID(),
          agentId,
          companyId,
          status: "active",
          createdAt: new Date().toISOString(),
        };
        sessions.set(session.sessionId, session);
        return { ...session };
      },
      list: async (agentId, companyId) => {
        requireCapability(manifest, "agents.sessions.list", "agent.sessions.list");
        return [...sessions.values()]
          .filter((s) => s.agentId === agentId && s.companyId === companyId && s.status === "active")
          .map((s) => ({ ...s }));
      },
      sendMessage: async (sessionId, companyId, opts) => {
        requireCapability(manifest, "agents.sessions.sendMessage", "agent.sessions.send");
        const session = sessions.get(sessionId);
        if (!session || session.status !== "active") throw new Error(`Session not found or closed: ${sessionId}`);
        if (session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
        const send: SessionSendRecord = {
          sessionId,
          agentId: session.agentId,
          companyId,
          prompt: opts.prompt,
          reason: opts.reason ?? null,
          runId: null,
          error: null,
        };
        this.sends.push(send);
        const failure = this.takeFailure(send);
        if (failure) {
          send.error = failure.message;
          throw failure;
        }
        // The host wakes the agent with an automation run; the plugin later reads it from the run table.
        const runId = randomUUID();
        await pg.query(
          "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, invocation_source, status) VALUES ($1, $2, $3, 'automation', 'queued')",
          [runId, companyId, session.agentId],
        );
        send.runId = runId;
        if (opts.onEvent) callbacks.set(sessionId, opts.onEvent);
        return { runId };
      },
      close: async (sessionId, companyId) => {
        requireCapability(manifest, "agents.sessions.close", "agent.sessions.close");
        const session = sessions.get(sessionId);
        if (!session || session.companyId !== companyId) throw new Error(`Session not found: ${sessionId}`);
        session.status = "closed";
        callbacks.delete(sessionId);
      },
    };
  }

  private takeFailure(send: SessionSendRecord): Error | null {
    const oneShot = this.oneShotFailures.shift();
    if (oneShot) return oneShot;
    const rule = this.failureRules.find((candidate) => candidate.predicate(send));
    return rule ? rule.makeError(send) : null;
  }
}
