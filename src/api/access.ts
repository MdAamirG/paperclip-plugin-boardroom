import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { Room } from "../db/index.js";
import { forbidden } from "./errors.js";

export type CompanyRole = "owner" | "admin" | "operator" | "viewer";
export type AccessLevel = "read" | "post" | "control";

const KNOWN_ROLES: readonly string[] = ["owner", "admin", "operator", "viewer"];

/** Who is calling, and what the company says they are. Looked up on every request, never cached. */
export interface Actor {
  userId: string;
  companyId: string;
  role: CompanyRole;
}

/**
 * Find the caller's company role through `ctx.access.members`.
 *
 * - An `agent` actor is refused (the host already blocks agents on `board` routes; this is
 *   defence in depth).
 * - A caller with no active membership is refused. The local board user has an owner membership
 *   in every company, so local mode needs no special case.
 * - A membership with no role (null) is treated as an operator: the host gives such a member
 *   normal access, so they may post, and control only a Room they own. A role string this plugin
 *   does not know is treated as a viewer (read only), the safe default.
 */
export async function resolveActor(ctx: PluginContext, input: PluginApiRequestInput): Promise<Actor> {
  if (input.actor.actorType !== "user") {
    throw forbidden("agent_not_allowed", "Agents cannot use the Boardroom API");
  }
  const userId = input.actor.userId ?? input.actor.actorId;
  if (!userId) throw forbidden("not_a_company_member", "No user on this request");
  const members = await ctx.access.members.list({ companyId: input.companyId });
  const member = members.find(
    (m) => m.companyId === input.companyId && m.principalType === "user" && m.principalId === userId && m.status === "active",
  );
  if (!member) throw forbidden("not_a_company_member", "You are not an active member of this company");
  const role = roleOf(member.membershipRole);
  return { userId, companyId: input.companyId, role };
}

function roleOf(membershipRole: string | null | undefined): CompanyRole {
  if (membershipRole === null || membershipRole === undefined) return "operator";
  return KNOWN_ROLES.includes(membershipRole) ? (membershipRole as CompanyRole) : "viewer";
}

/** `post` level: any non-viewer. */
export function canPost(actor: Actor): boolean {
  return actor.role !== "viewer";
}

/** `control` level: the Room's Owner, or a company owner or admin. */
export function canControl(actor: Actor, room: Pick<Room, "ownerUserId">): boolean {
  return actor.role === "owner" || actor.role === "admin" || room.ownerUserId === actor.userId;
}

/**
 * Enforce a level. `read` needs only the membership `resolveActor` already proved; `control`
 * needs the Room. A Room Owner who is now a viewer does not control the Room (the role wins).
 */
export function requireLevel(actor: Actor, level: "read" | "post"): void;
export function requireLevel(actor: Actor, level: "control", room: Pick<Room, "ownerUserId">): void;
export function requireLevel(actor: Actor, level: AccessLevel, room?: Pick<Room, "ownerUserId">): void {
  if (level === "read") return;
  if (level === "post") {
    if (!canPost(actor)) throw forbidden("role_cannot_post", "Viewers have read-only access");
    return;
  }
  if (!room) throw new Error("requireLevel('control') needs the Room");
  if (!canPost(actor) || !canControl(actor, room)) {
    throw forbidden("control_requires_owner_or_admin", "Only the Room Owner or a company owner or admin can do this");
  }
}
