/**
 * Seed helpers: host records (companies, agents, members) in both the database and the SDK
 * harness, and core rows (runs, cost events) in the database.
 */
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company } from "@paperclipai/shared";
import type { HostRecords } from "./records.js";

export const MEMBER_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface SeededMember {
  memberId: string;
  userId: string;
  companyId: string;
  role: MemberRole;
}

export interface SeededAgent {
  id: string;
  companyId: string;
  name: string;
}

export interface SeededCompany {
  id: string;
  name: string;
  issuePrefix: string;
  agents: SeededAgent[];
  members: Record<MemberRole, SeededMember>;
}

export interface SeedRunInput {
  companyId: string;
  agentId: string;
  id?: string;
  status?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  resultJson?: Record<string, unknown> | null;
}

export interface SeedCostEventInput {
  companyId: string;
  agentId: string;
  costCents: number;
  runId?: string | null;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  occurredAt?: string;
}

export class Seeder {
  private companyCounter = 0;

  constructor(
    private readonly pg: PGlite,
    private readonly records: HostRecords,
    private readonly currentSdk: () => TestHarness,
  ) {}

  async company(input: { name?: string; issuePrefix?: string; agents?: string[] } = {}): Promise<SeededCompany> {
    this.companyCounter += 1;
    const n = this.companyCounter;
    const id = randomUUID();
    const name = input.name ?? `Company ${n}`;
    const issuePrefix = input.issuePrefix ?? `C${n}`;
    const now = new Date();
    await this.pg.query("INSERT INTO public.companies (id, name, issue_prefix) VALUES ($1, $2, $3)", [id, name, issuePrefix]);
    // Test-only partial records: the SDK harness reads ids, company ids, names and statuses.
    const company = { id, name, issuePrefix, status: "active", description: null, createdAt: now, updatedAt: now } as unknown as Company;
    this.records.companies.set(id, company);

    const seededAgents: SeededAgent[] = [];
    for (const agentName of input.agents ?? ["CEO", "CTO", "CFO"]) {
      const agentId = randomUUID();
      await this.pg.query("INSERT INTO public.agents (id, company_id, name) VALUES ($1, $2, $3)", [agentId, id, agentName]);
      const agent = {
        id: agentId,
        companyId: id,
        name: agentName,
        urlKey: agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        role: "general",
        title: null,
        status: "idle",
        reportsTo: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      } as unknown as Agent;
      this.records.agents.set(agentId, agent);
      seededAgents.push({ id: agentId, companyId: id, name: agentName });
    }

    const members = {} as Record<MemberRole, SeededMember>;
    for (const role of MEMBER_ROLES) {
      const member: SeededMember = { memberId: randomUUID(), userId: `user-${role}-${n}`, companyId: id, role };
      this.records.accessMembers.push({
        id: member.memberId,
        companyId: id,
        principalType: "user",
        principalId: member.userId,
        status: "active",
        membershipRole: role,
        grants: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      members[role] = member;
    }

    this.currentSdk().seed({
      companies: [company],
      agents: seededAgents.map((a) => this.records.agents.get(a.id)!),
      accessMembers: this.records.accessMembers.filter((m) => m.companyId === id),
    });
    return { id, name, issuePrefix, agents: seededAgents, members };
  }

  async run(input: SeedRunInput): Promise<{ id: string }> {
    const id = input.id ?? randomUUID();
    await this.pg.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, result_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        input.companyId,
        input.agentId,
        input.status ?? "succeeded",
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.error ?? null,
        input.resultJson === undefined || input.resultJson === null ? null : JSON.stringify(input.resultJson),
      ],
    );
    return { id };
  }

  async costEvent(input: SeedCostEventInput): Promise<{ id: string }> {
    const id = randomUUID();
    await this.pg.query(
      `INSERT INTO public.cost_events
         (id, company_id, agent_id, heartbeat_run_id, provider, model, input_tokens, output_tokens, cost_cents, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        input.companyId,
        input.agentId,
        input.runId ?? null,
        input.provider ?? "anthropic",
        input.model ?? "test-model",
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.costCents,
        input.occurredAt ?? new Date().toISOString(),
      ],
    );
    return { id };
  }
}
