/**
 * Host-owned records that outlive a plugin restart, because the host keeps them in its database:
 * companies, agents, members, issues, issue comments, issue documents and plugin state.
 *
 * The SDK test harness keeps state and documents in closures that a new harness cannot read, so
 * this module serves `ctx.state` and `ctx.issues.documents` itself (host-like fakes with the
 * host's capability checks). Issues and comments stay in the SDK harness; they are captured
 * before a restart and seeded into the next one.
 *
 * Not carried across a restart (the plugin does not use them): entities, interactions,
 * attachments, approvals, projects and goals.
 */
import { randomUUID } from "node:crypto";
import type { PluginAccessMember, PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, IssueComment, IssueDocument, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { requireCapability, viaJson } from "./errors.js";

function stateKey(input: ScopeKey): string {
  return `${input.scopeKind}|${input.scopeId ?? ""}|${input.namespace ?? "default"}|${input.stateKey}`;
}

export class HostRecords {
  readonly companies = new Map<string, Company>();
  readonly agents = new Map<string, Agent>();
  readonly accessMembers: PluginAccessMember[] = [];
  private issues: Issue[] = [];
  private readonly issueCompany = new Map<string, string>();
  private readonly comments: IssueComment[] = [];
  private readonly state = new Map<string, unknown>();
  private readonly documents = new Map<string, IssueDocument>();

  constructor(private readonly manifest: PaperclipPluginManifestV1) {}

  /** What a new SDK harness is seeded with on every start. */
  seedInput(): Parameters<TestHarness["seed"]>[0] {
    return {
      companies: [...this.companies.values()],
      agents: [...this.agents.values()],
      accessMembers: this.accessMembers,
      issues: this.issues,
      issueComments: this.comments,
    };
  }

  /** The company of an issue the host knows, as the host's issue lookup returns it. */
  companyOfIssue(issueId: string): string | null {
    return this.issueCompany.get(issueId) ?? null;
  }

  /** Read the issues from the running SDK harness so the next start can seed them. */
  async captureIssues(sdk: TestHarness): Promise<void> {
    if (!(this.manifest.capabilities as readonly string[]).includes("issues.read")) return;
    const lists = await Promise.all([...this.companies.keys()].map((companyId) => sdk.ctx.issues.list({ companyId })));
    this.issues = lists.flat();
    for (const issue of this.issues) this.issueCompany.set(issue.id, issue.companyId);
  }

  /** Serve host-owned records on a new plugin context. */
  install(ctx: PluginContext): void {
    const { manifest, state, documents, comments, issueCompany } = this;
    const inCompany = (issueId: string, companyId: string) => issueCompany.get(issueId) === companyId;

    ctx.state = {
      async get(input) {
        requireCapability(manifest, "state.get", "plugin.state.read");
        return state.has(stateKey(input)) ? viaJson(state.get(stateKey(input))) : null;
      },
      async set(input, value) {
        requireCapability(manifest, "state.set", "plugin.state.write");
        state.set(stateKey(input), viaJson(value));
      },
      async delete(input) {
        requireCapability(manifest, "state.delete", "plugin.state.write");
        state.delete(stateKey(input));
      },
    };

    ctx.issues.documents = {
      async list(issueId, companyId) {
        requireCapability(manifest, "issues.documents.list", "issue.documents.read");
        if (!inCompany(issueId, companyId)) return [];
        return [...documents.values()]
          .filter((d) => d.issueId === issueId)
          .map(({ body: _body, ...summary }) => viaJson(summary));
      },
      async get(issueId, key, companyId) {
        requireCapability(manifest, "issues.documents.get", "issue.documents.read");
        if (!inCompany(issueId, companyId)) return null;
        return viaJson(documents.get(`${issueId}|${key}`) ?? null);
      },
      async upsert(input) {
        requireCapability(manifest, "issues.documents.upsert", "issue.documents.write");
        if (!inCompany(input.issueId, input.companyId)) throw new Error(`Issue not found: ${input.issueId}`);
        const now = new Date();
        const existing = documents.get(`${input.issueId}|${input.key}`);
        const document = {
          id: existing?.id ?? randomUUID(),
          companyId: input.companyId,
          issueId: input.issueId,
          key: input.key,
          title: input.title ?? existing?.title ?? null,
          format: "markdown",
          latestRevisionId: randomUUID(),
          latestRevisionNumber: (existing?.latestRevisionNumber ?? 0) + 1,
          createdByAgentId: existing?.createdByAgentId ?? null,
          createdByUserId: existing?.createdByUserId ?? null,
          updatedByAgentId: null,
          updatedByUserId: null,
          lockedAt: existing?.lockedAt ?? null,
          lockedByAgentId: existing?.lockedByAgentId ?? null,
          lockedByUserId: existing?.lockedByUserId ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          body: input.body,
        } as unknown as IssueDocument;
        documents.set(`${input.issueId}|${input.key}`, document);
        return viaJson(document);
      },
      async delete(issueId, key, companyId) {
        requireCapability(manifest, "issues.documents.delete", "issue.documents.write");
        if (!inCompany(issueId, companyId)) throw new Error(`Issue not found: ${issueId}`);
        documents.delete(`${issueId}|${key}`);
      },
    };

    // Issues and comments live in the SDK harness; record what the plugin creates so a restart keeps it.
    const createIssue = ctx.issues.create.bind(ctx.issues);
    ctx.issues.create = async (...args) => {
      const issue = await createIssue(...args);
      issueCompany.set(issue.id, issue.companyId);
      return issue;
    };
    const createComment = ctx.issues.createComment.bind(ctx.issues);
    ctx.issues.createComment = async (...args) => {
      const comment = await createComment(...args);
      comments.push(comment);
      return comment;
    };
  }
}
