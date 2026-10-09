import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { listWorkLinks, type WorkLink } from "../db/index.js";
import type { WorkIssueView, WorkLinkView } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The few live issue fields the Room page shows. Agent name is looked up separately. */
export async function toWorkIssueView(ctx: PluginContext, issue: Issue): Promise<WorkIssueView> {
  let assigneeAgentName: string | null = null;
  if (issue.assigneeAgentId) {
    const agent = await ctx.agents.get(issue.assigneeAgentId, issue.companyId).catch((error: unknown) => {
      ctx.logger.warn("Boardroom could not look up an assignee name", { agentId: issue.assigneeAgentId, error: errorMessage(error) });
      return null;
    });
    assigneeAgentName = agent?.name ?? null;
  }
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    priority: issue.priority ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeAgentName,
    assigneeUserId: issue.assigneeUserId ?? null,
    projectId: issue.projectId ?? null,
  };
}

/** Attach the live issue to each link. A failed or empty read gives `issue: null`; it never fails the Room. */
export async function withIssues(ctx: PluginContext, companyId: string, links: WorkLink[]): Promise<WorkLinkView[]> {
  return Promise.all(
    links.map(async (link) => {
      try {
        const issue = await ctx.issues.get(link.issueId, companyId);
        return { ...link, issue: issue ? await toWorkIssueView(ctx, issue) : null };
      } catch (error) {
        ctx.logger.warn("Boardroom could not read a linked issue", { issueId: link.issueId, error: errorMessage(error) });
        return { ...link, issue: null };
      }
    }),
  );
}

/** A Room's follow-up work with live issue identifier, title, status and assignee. */
export async function listWorkLinkViews(ctx: PluginContext, companyId: string, roomId: string): Promise<WorkLinkView[]> {
  return withIssues(ctx, companyId, await listWorkLinks(ctx.db, companyId, roomId));
}
