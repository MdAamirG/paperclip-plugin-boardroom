/**
 * Follow-up work (ticket 12): create, link and unlink through the plugin API route, the live work list on
 * the Room detail, the activity entries and the Room-changed event. Issues are seeded with
 * `h.ctx.issues.create` (the harness issue store) and read back from it.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import defaultManifest from "../../src/manifest.js";
import { ROUTE_SPECS } from "../../src/api/route-table.js";
import type { ApiErrorBody } from "../../src/api/errors.js";
import type { CreateWorkResponse, RemoveWorkLinkResponse, RoomDetail, WorkLinkView } from "../../src/api/types.js";
import { WORK_ORIGIN_KIND } from "../../src/api/work.js";
import { insertWorkLink } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness, type MemberRole, type SeededCompany } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * The shipped manifest cannot read documents or update issues; the tests add those capabilities to
 * read the plan back and to change an issue the way another user would.
 */
async function start(): Promise<BoardroomHarness> {
  harness = await createBoardroomHarness({
    manifest: { ...defaultManifest, capabilities: [...defaultManifest.capabilities, "issue.documents.read", "issues.update"] },
  });
  return harness;
}

interface CapturedCreate {
  input: Parameters<BoardroomHarness["ctx"]["issues"]["create"]>[0];
}

/** Record every `ctx.issues.create` input (the SDK fake ignores the acting user, so the test reads it here). */
function captureCreates(h: BoardroomHarness): CapturedCreate[] {
  const captured: CapturedCreate[] = [];
  const create = h.ctx.issues.create.bind(h.ctx.issues);
  h.ctx.issues.create = async (input) => {
    captured.push({ input });
    return create(input);
  };
  return captured;
}

async function openRoom(h: BoardroomHarness, company: SeededCompany, extra: Record<string, unknown> = {}, role: MemberRole = "operator") {
  const response = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title: "Raise prices?", topic: "Should we?", agentIds: company.agents.map((a) => a.id), ...extra },
    actor: company.members[role],
  });
  expect(response.status).toBe(201);
  return response.body.room;
}

function createWork(h: BoardroomHarness, company: SeededCompany, roomId: string, body: Record<string, unknown>, role: MemberRole = "operator") {
  return h.request<CreateWorkResponse>("POST", `/rooms/${roomId}/work`, {
    body: { companyId: company.id, ...body },
    actor: company.members[role],
  });
}

function linkIssue(h: BoardroomHarness, company: SeededCompany, roomId: string, issueId: unknown, role: MemberRole = "operator") {
  return h.request<WorkLinkView>("POST", `/rooms/${roomId}/work-links`, {
    body: { companyId: company.id, issueId },
    actor: company.members[role],
  });
}

function unlinkIssue(h: BoardroomHarness, company: SeededCompany, roomId: string, issueId: string, role: MemberRole = "operator") {
  return h.request<RemoveWorkLinkResponse>("DELETE", `/rooms/${roomId}/work-links/${issueId}`, {
    query: { companyId: company.id },
    actor: company.members[role],
  });
}

const getDetail = (h: BoardroomHarness, company: SeededCompany, roomId: string) =>
  h.request<RoomDetail>("GET", `/rooms/${roomId}`, { query: { companyId: company.id }, actor: company.members.owner });

function expectError(response: { status: number; body: unknown }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((response.body as ApiErrorBody).error).toBe(code);
  expect(typeof (response.body as ApiErrorBody).message).toBe("string");
}

async function closeRoom(h: BoardroomHarness, roomId: string) {
  await h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET status = 'closed', closed_at = now() WHERE id = $1", [roomId]);
}

function seedProject(h: BoardroomHarness, companyId: string, name = "Growth"): string {
  const id = randomUUID();
  h.sdk.seed({ projects: [{ id, companyId, name }] as never });
  return id;
}

describe("create follow-up work", () => {
  it("creates an ordinary issue with the plugin origin, the acting user, the Room's project and a plan document", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const project = seedProject(h, company.id);
    const room = await openRoom(h, company, { projectId: project });
    const captured = captureCreates(h);

    const response = await createWork(h, company, room.id, {
      title: "Raise prices by 10 percent",
      description: "Roll out in Q1",
      plan: "## Plan\n\n1. Announce\n2. Roll out",
      priority: "high",
      assigneeAgentId: company.agents[0]!.id,
    });
    expect(response.status).toBe(201);
    expect(response.body.planSaved).toBe(true);

    const issues = await h.ctx.issues.list({ companyId: company.id });
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({
      title: "Raise prices by 10 percent",
      description: "Roll out in Q1",
      originKind: "plugin:mdaamirg.boardroom",
      originId: room.id,
      projectId: project,
      priority: "high",
      assigneeAgentId: company.agents[0]!.id,
    });
    expect(WORK_ORIGIN_KIND).toBe("plugin:mdaamirg.boardroom");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.input.actor).toEqual({ actorUserId: company.members.operator.userId });

    const plan = await h.ctx.issues.documents.get(issue.id, "plan", company.id);
    expect(plan?.body).toBe("## Plan\n\n1. Announce\n2. Roll out");

    const detail = (await getDetail(h, company, room.id)).body;
    expect(detail.workLinks).toHaveLength(1);
    expect(detail.workLinks[0]).toMatchObject({
      issueId: issue.id,
      relation: "created",
      byUserId: company.members.operator.userId,
      issue: { id: issue.id, title: "Raise prices by 10 percent", status: "todo", assigneeAgentName: company.agents[0]!.name, projectId: project },
    });
    expect(response.body.workLink.issueId).toBe(issue.id);
    expect(response.body.issue.id).toBe(issue.id);
  });

  it("writes no plan document when no plan is given, and uses no project when the Room has none", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const response = await createWork(h, company, room.id, { title: "Just do it", plan: "   " });
    expect(response.status).toBe(201);
    const [issue] = await h.ctx.issues.list({ companyId: company.id });
    expect(issue!.projectId).toBeNull();
    expect(await h.ctx.issues.documents.get(issue!.id, "plan", company.id)).toBeNull();
  });

  it("uses an explicit project instead of the Room's", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const roomProject = seedProject(h, company.id, "Room project");
    const other = seedProject(h, company.id, "Other");
    const room = await openRoom(h, company, { projectId: roomProject });
    expect((await createWork(h, company, room.id, { title: "A", projectId: other })).status).toBe(201);
    const [issue] = await h.ctx.issues.list({ companyId: company.id });
    expect(issue!.projectId).toBe(other);
  });

  it("refuses a project or assignee of another company before creating anything", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const stranger = await h.seedCompany();
    const theirs = seedProject(h, stranger.id);
    const room = await openRoom(h, company);
    expectError(await createWork(h, company, room.id, { title: "A", projectId: theirs }), 422, "project_not_in_company");
    expectError(await createWork(h, company, room.id, { title: "A", projectId: "nope" }), 422, "project_not_in_company");
    expectError(await createWork(h, company, room.id, { title: "A", assigneeAgentId: stranger.agents[0]!.id }), 422, "agent_not_in_company");
    expect(await h.ctx.issues.list({ companyId: company.id })).toEqual([]);
    expect(h.activity.filter((e) => e.message.startsWith("Work"))).toEqual([]);
  });

  it("validates the body", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    expectError(await createWork(h, company, room.id, {}), 400, "invalid_request");
    expectError(await createWork(h, company, room.id, { title: "  " }), 400, "invalid_request");
    expectError(await createWork(h, company, room.id, { title: "A", priority: "urgent" }), 400, "invalid_request");
    expectError(await createWork(h, company, room.id, { title: "A", plan: 7 }), 400, "invalid_request");
    expectError(
      await createWork(h, company, room.id, { title: "A", assigneeAgentId: company.agents[0]!.id, assigneeUserId: "someone" }),
      400,
      "invalid_request",
    );
    expect(await h.ctx.issues.list({ companyId: company.id })).toEqual([]);
  });

  it("returns the host's message with a matching status when issue creation fails, and records nothing", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    h.ctx.issues.create = async () => {
      throw new Error("Project must belong to the same company");
    };
    const refused = await createWork(h, company, room.id, { title: "A" });
    expectError(refused, 422, "issue_create_failed");
    expect((refused.body as unknown as ApiErrorBody).message).toBe("Project must belong to the same company");

    h.ctx.issues.create = async () => {
      throw Object.assign(new Error("Budget exceeded"), { status: 409 });
    };
    expectError(await createWork(h, company, room.id, { title: "A" }), 409, "issue_create_failed");

    const detail = (await getDetail(h, company, room.id)).body;
    expect(detail.workLinks).toEqual([]);
    expect(h.activity.filter((e) => e.message.startsWith("Work"))).toEqual([]);
    expect(h.streamEvents.filter((e) => (e.event as { roomId?: string }).roomId === room.id)).toHaveLength(1); // only the Room create
  });

  it("keeps the issue and the link when the plan cannot be saved, and says so", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    h.ctx.issues.documents.upsert = async () => {
      throw new Error("Document store is down");
    };
    const response = await createWork(h, company, room.id, { title: "A", plan: "The plan" });
    expect(response.status).toBe(201);
    expect(response.body.planSaved).toBe(false);
    expect(response.body.planError).toBe("Document store is down");
    expect((await getDetail(h, company, room.id)).body.workLinks).toHaveLength(1);
    expect(h.activity.find((e) => e.message === "Work created")?.metadata).toMatchObject({ planSaved: false });
  });

  it("answers 500 work_link_failed, naming the task, when the link cannot be written after the issue exists", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const realDb = h.ctx.db;
    h.ctx.db = { ...realDb, namespace: realDb.namespace, query: realDb.query.bind(realDb), execute: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO") && sql.includes("work_links")) throw new Error("Failed query: boom");
      return realDb.execute(sql, params);
    } } as typeof realDb;
    const response = await createWork(h, company, room.id, { title: "A" });
    expectError(response, 500, "work_link_failed");
    expect((response.body as unknown as ApiErrorBody).details).toMatchObject({ issueId: (await h.ctx.issues.list({ companyId: company.id }))[0]!.id });
  });
});

describe("link and unlink", () => {
  it("links an issue of the company as `linked`, refuses a second link with 409, and an issue of another company with 404", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const stranger = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing work" });
    const theirs = await h.ctx.issues.create({ companyId: stranger.id, title: "Theirs" });

    const linked = await linkIssue(h, company, room.id, issue.id);
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ issueId: issue.id, relation: "linked", byUserId: company.members.operator.userId, issue: { title: "Existing work" } });

    expectError(await linkIssue(h, company, room.id, issue.id), 409, "already_linked");
    expectError(await linkIssue(h, company, room.id, theirs.id), 404, "issue_not_found");
    expectError(await linkIssue(h, company, room.id, randomUUID()), 404, "issue_not_found");
    expectError(await linkIssue(h, company, room.id, "nope"), 404, "issue_not_found");
    expectError(await linkIssue(h, company, room.id, undefined), 400, "invalid_request");
    expectError(await linkIssue(h, company, room.id, 12), 400, "invalid_request");

    const detail = (await getDetail(h, company, room.id)).body;
    expect(detail.workLinks.map((l) => [l.issueId, l.relation])).toEqual([[issue.id, "linked"]]);
  });

  it("unlinks either relation and leaves the issue in place", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const existing = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    expect((await linkIssue(h, company, room.id, existing.id)).status).toBe(201);
    const created = (await createWork(h, company, room.id, { title: "Made here" })).body.issue;
    expect((await getDetail(h, company, room.id)).body.workLinks).toHaveLength(2);

    expect((await unlinkIssue(h, company, room.id, created.id)).body).toEqual({ removed: true, issueId: created.id });
    expect((await unlinkIssue(h, company, room.id, existing.id)).status).toBe(200);

    expect((await getDetail(h, company, room.id)).body.workLinks).toEqual([]);
    expect(await h.sql("SELECT 1 FROM plugin_boardroom_79f8e138fc.work_links")).toEqual([]);
    expect(await h.ctx.issues.get(created.id, company.id)).toMatchObject({ title: "Made here" });
    expect(await h.ctx.issues.get(existing.id, company.id)).toMatchObject({ title: "Existing" });
    // The link can be made again afterwards.
    expect((await linkIssue(h, company, room.id, created.id)).status).toBe(201);
  });

  it("answers 404 when the issue is not linked, and never touches another Room's link", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const other = await openRoom(h, company, { title: "Other" });
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await linkIssue(h, company, other.id, issue.id);
    expectError(await unlinkIssue(h, company, room.id, issue.id), 404, "work_link_not_found");
    expectError(await unlinkIssue(h, company, room.id, "nope"), 404, "work_link_not_found");
    expect((await getDetail(h, company, other.id)).body.workLinks).toHaveLength(1);
  });

  it("answers 404 for a Room of another company or an unknown Room", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const stranger = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: stranger.id, title: "Theirs" });
    expectError(await createWork(h, stranger, room.id, { title: "A" }), 404, "room_not_found");
    expectError(await linkIssue(h, stranger, room.id, issue.id), 404, "room_not_found");
    expectError(await unlinkIssue(h, stranger, room.id, issue.id), 404, "room_not_found");
    expectError(await createWork(h, company, randomUUID(), { title: "A" }), 404, "room_not_found");
  });
});

describe("closed Rooms", () => {
  it("allows create, link and unlink after the Room is closed", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const existing = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await closeRoom(h, room.id);

    const created = await createWork(h, company, room.id, { title: "Late work", plan: "Plan" });
    expect(created.status).toBe(201);
    expect((await linkIssue(h, company, room.id, existing.id)).status).toBe(201);
    expect((await unlinkIssue(h, company, room.id, existing.id)).status).toBe(200);
    const detail = (await getDetail(h, company, room.id)).body;
    expect(detail.room.status).toBe("closed");
    expect(detail.workLinks.map((l) => l.relation)).toEqual(["created"]);
  });
});

describe("access", () => {
  it("answers a viewer 403 on all three routes, at the host and in the plugin itself", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await linkIssue(h, company, room.id, issue.id);

    expect((await createWork(h, company, room.id, { title: "A" }, "viewer")).status).toBe(403);
    expect((await linkIssue(h, company, room.id, issue.id, "viewer")).status).toBe(403);
    expect((await unlinkIssue(h, company, room.id, issue.id, "viewer")).status).toBe(403);

    // The host blocks a viewer first; call the worker directly to reach the plugin's own rule.
    const viewer = company.members.viewer;
    for (const [routeKey, params, body] of [
      ["work.create", { roomId: room.id }, { companyId: company.id, title: "A" }],
      ["work-links.add", { roomId: room.id }, { companyId: company.id, issueId: issue.id }],
      ["work-links.remove", { roomId: room.id, issueId: issue.id }, null],
    ] as const) {
      const spec = ROUTE_SPECS.find((s) => s.routeKey === routeKey)!;
      const input: PluginApiRequestInput = {
        routeKey,
        method: spec.method,
        path: spec.path,
        params: { ...params },
        query: { companyId: company.id },
        body,
        actor: { actorType: "user", actorId: viewer.userId, userId: viewer.userId, agentId: null, runId: null },
        companyId: company.id,
        headers: {},
      };
      const response = (await h.plugin.definition.onApiRequest!(JSON.parse(JSON.stringify(input)))) as { status: number; body: unknown };
      expectError(response, 403, "role_cannot_post");
    }
    expect(await h.ctx.issues.list({ companyId: company.id })).toHaveLength(1);
    expect((await getDetail(h, company, room.id)).body.workLinks).toHaveLength(1);
  });

  it("lets an operator, admin and owner do it, and refuses an agent", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    for (const role of ["operator", "admin", "owner"] as const) {
      expect((await createWork(h, company, room.id, { title: `By ${role}` }, role)).status).toBe(201);
    }
    const agent = await h.request("POST", `/rooms/${room.id}/work`, { body: { companyId: company.id, title: "A" }, actor: company.agents[0]! });
    expect(agent.status).toBe(403);
  });
});

describe("work list, activity and live updates", () => {
  it("reads title, status and assignee live, and tolerates an issue that can no longer be read", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await linkIssue(h, company, room.id, issue.id);
    expect((await getDetail(h, company, room.id)).body.workLinks[0]!.issue).toMatchObject({ title: "Existing", status: "todo", assigneeAgentId: null });

    await h.ctx.issues.update(issue.id, { title: "Renamed", status: "in_progress", assigneeAgentId: company.agents[1]!.id }, company.id);
    expect((await getDetail(h, company, room.id)).body.workLinks[0]!.issue).toMatchObject({
      title: "Renamed",
      status: "in_progress",
      assigneeAgentId: company.agents[1]!.id,
      assigneeAgentName: company.agents[1]!.name,
    });

    // A link whose issue is gone (or unreadable) shows with `issue: null`, and the Room still loads.
    await insertWorkLink(h.ctx.db, company.id, { roomId: room.id, issueId: randomUUID(), relation: "linked", byUserId: company.members.owner.userId });
    const links = (await getDetail(h, company, room.id)).body.workLinks;
    expect(links).toHaveLength(2);
    expect(links[1]!.issue).toBeNull();
    h.ctx.issues.get = async () => {
      throw new Error("host unavailable");
    };
    const failing = await getDetail(h, company, room.id);
    expect(failing.status).toBe(200);
    expect(failing.body.workLinks.map((l) => l.issue)).toEqual([null, null]);
  });

  it("writes Work created, Work linked and Work unlinked with the acting user, and one room.changed each", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const existing = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    const base = h.activity.length;
    const eventsBefore = h.streamEvents.length;
    const operator = company.members.operator;

    const created = (await createWork(h, company, room.id, { title: "Made here", plan: "P" })).body;
    await linkIssue(h, company, room.id, existing.id);
    await unlinkIssue(h, company, room.id, existing.id);
    await linkIssue(h, company, room.id, existing.id); // 201 again: no extra assertions
    expectError(await linkIssue(h, company, room.id, existing.id), 409, "already_linked");

    const entries = h.activity.slice(base);
    expect(entries.map((e) => e.message)).toEqual(["Work created", "Work linked", "Work unlinked", "Work linked"]);
    for (const entry of entries) {
      expect(entry.entityType).toBe("boardroom_room");
      expect(entry.entityId).toBe(room.id);
      expect(entry.metadata).toMatchObject({ actingUserId: operator.userId, roomId: room.id });
    }
    expect(entries[0]!.metadata).toMatchObject({ issueId: created.issue.id, title: "Made here", relation: "created", planSaved: true });
    expect(entries[1]!.metadata).toMatchObject({ issueId: existing.id, relation: "linked" });
    expect(entries[2]!.metadata).toMatchObject({ issueId: existing.id, relation: "linked" });

    const events = h.streamEvents.slice(eventsBefore);
    expect(events).toHaveLength(4); // the refused 409 emits nothing
    for (const record of events) {
      expect(record).toMatchObject({ channel: "boardroom", companyId: company.id, event: { type: "room.changed", roomId: room.id, companyId: company.id } });
    }
  });

  it("bumps the Room's updated_at on each mutation, and writes nothing for a refused request", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    const updatedAt = async () =>
      new Date((await h.sql<{ updated_at: string }>("SELECT updated_at FROM plugin_boardroom_79f8e138fc.rooms WHERE id = $1", [room.id]))[0]!.updated_at).getTime();
    await h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1", [room.id]);

    expectError(await linkIssue(h, company, room.id, randomUUID()), 404, "issue_not_found");
    expect(await updatedAt()).toBe(new Date("2020-01-01T00:00:00Z").getTime());
    await linkIssue(h, company, room.id, issue.id);
    const afterLink = await updatedAt();
    expect(afterLink).toBeGreaterThan(new Date("2024-01-01T00:00:00Z").getTime());

    await h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1", [room.id]);
    await unlinkIssue(h, company, room.id, issue.id);
    expect(await updatedAt()).toBeGreaterThan(new Date("2024-01-01T00:00:00Z").getTime());
    await h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1", [room.id]);
    await createWork(h, company, room.id, { title: "A" });
    expect(await updatedAt()).toBeGreaterThan(new Date("2024-01-01T00:00:00Z").getTime());
  });

  it("does not fail the request when the activity write fails", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    h.ctx.activity.log = async () => {
      throw new Error("activity down");
    };
    expect((await createWork(h, company, room.id, { title: "A" })).status).toBe(201);
  });
});
