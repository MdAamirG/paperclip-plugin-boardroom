import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listActiveParticipants, listParticipantAgentIds } from "../db/index.js";
import type { IgnoredMention } from "./types.js";
import { isUuid } from "./validation.js";

export interface ResolvedMentions {
  /** Agent ids of active Participants, deduplicated, in the order written. */
  valid: string[];
  ignored: IgnoredMention[];
}

/**
 * Turn a send's mentions into addressed Participants.
 *
 * The structured `mentions` list (agent ids from the composer's picker) is the source of truth,
 * so a renamed agent never breaks a mention. Cross-check against the body: an active Participant
 * written by hand as `@Exact Name`, and missing from the list, is added after the listed ones
 * (in the order they appear in the body). Hand-typed names that match nobody, or that are shared
 * by two Participants, are plain text and are not reported.
 *
 * Every listed id that is not an active Participant is ignored with a reason:
 * `removed_participant`, `not_a_participant` (a real agent of the company that is not in the
 * Room) or `unknown_agent` (not an agent of this company, or not an id at all).
 */
export async function resolveMentions(
  ctx: PluginContext,
  input: { companyId: string; roomId: string; body: string; mentions: readonly string[] },
): Promise<ResolvedMentions> {
  const { companyId, roomId, body } = input;
  const listed = [...new Set(input.mentions.map((id) => id.trim().toLowerCase()).filter((id) => id !== ""))];
  const known = await listParticipantAgentIds(ctx.db, companyId, roomId);

  const valid: string[] = [];
  const ignored: IgnoredMention[] = [];
  for (const agentId of listed) {
    if (known.active.has(agentId)) {
      valid.push(agentId);
    } else if (!isUuid(agentId)) {
      ignored.push({ agentId, name: null, reason: "unknown_agent" });
    } else if (known.removed.has(agentId)) {
      ignored.push({ agentId, name: await agentName(ctx, companyId, agentId), reason: "removed_participant" });
    } else {
      const name = await agentName(ctx, companyId, agentId);
      ignored.push({ agentId, name, reason: name === null ? "unknown_agent" : "not_a_participant" });
    }
  }

  if (body.includes("@") && known.active.size > 0) {
    const participants = await listActiveParticipants(ctx.db, companyId, roomId);
    const named = await Promise.all(
      participants.map(async (p) => ({ agentId: p.agentId.toLowerCase(), name: await agentName(ctx, companyId, p.agentId) })),
    );
    for (const agentId of findHandTypedMentions(body, named)) {
      if (!valid.includes(agentId)) valid.push(agentId);
    }
  }
  return { valid, ignored };
}

/** The agent's name, or null when it has none or cannot be looked up (never throws). */
async function agentName(ctx: PluginContext, companyId: string, agentId: string): Promise<string | null> {
  if (!isUuid(agentId)) return null;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    return agent?.name ?? null;
  } catch (error) {
    ctx.logger.warn("Boardroom could not look up an agent name", {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const WORD = "\\p{L}\\p{N}_";

/**
 * Agent ids whose exact name appears in `body` as `@Name`, in body order. The `@` must not follow
 * a word character (so an e-mail address is not a mention) and the name must not run into more
 * letters (so `@Ada` is not `@Adam`). Longer names win, so `@Ada Lovelace` is not also `@Ada`.
 * A name used by two or more candidates is ambiguous and never matches.
 */
export function findHandTypedMentions(body: string, candidates: readonly { agentId: string; name: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const c of candidates) if (c.name?.trim()) counts.set(c.name.trim(), (counts.get(c.name.trim()) ?? 0) + 1);
  const usable = candidates
    .filter((c): c is { agentId: string; name: string } => !!c.name?.trim() && counts.get(c.name.trim()) === 1)
    .map((c) => ({ agentId: c.agentId, name: c.name.trim() }))
    .sort((a, b) => b.name.length - a.name.length);

  const taken: Array<[number, number]> = [];
  const found: Array<{ at: number; agentId: string }> = [];
  for (const { agentId, name } of usable) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![${WORD}])@${escaped}(?![${WORD}])`, "gu");
    for (const match of body.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ at: start, agentId });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.agentId))];
}
