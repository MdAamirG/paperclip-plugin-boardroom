/**
 * The issue-to-Room lookup behind the "From Room" chip (ticket 13): `GET /issues/:issueId/rooms`,
 * through the PGlite harness. The host resolves the company from the issue.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IssueRoomsResponse, RoomDetail } from "../../src/api/types.js";
import { insertWorkLink } from "../../src/db/index.js";
import { createBoardroomHarness, type BoardroomHarness, type MemberRole, type SeededCompany } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start() {
  harness = await createBoardroomHarness();
  return harness;
}

async function openRoom(h: BoardroomHarness, company: SeededCompany, title = "Raise prices?") {
  const response = await h.request<RoomDetail>("POST", "/rooms", {
    body: { companyId: company.id, title, topic: "Should we?", agentIds: company.agents.map((a) => a.id) },
    actor: company.members.owner,
  });
  expect(response.status).toBe(201);
  return response.body.room;
}

const lookup = (h: BoardroomHarness, company: SeededCompany, issueId: string, role: MemberRole = "operator") =>
  h.request<IssueRoomsResponse>("GET", `/issues/${issueId}/rooms`, { actor: company.members[role] });

describe("issue rooms lookup", () => {
  it("returns the Room of a created link and of a linked link, and an empty list for an issue with none", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company, "Pricing");
    const made = await h.request<{ issue: { id: string } }>("POST", `/rooms/${room.id}/work`, {
      body: { companyId: company.id, title: "Do it" },
      actor: company.members.operator,
    });
    expect(made.status).toBe(201);
    const existing = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    const linked = await h.request("POST", `/rooms/${room.id}/work-links`, {
      body: { companyId: company.id, issueId: existing.id },
      actor: company.members.operator,
    });
    expect(linked.status).toBe(201);
    const plain = await h.ctx.issues.create({ companyId: company.id, title: "Plain" });

    const created = await lookup(h, company, made.body.issue.id);
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ rooms: [{ roomId: room.id, title: "Pricing", status: "open", relation: "created" }] });
    expect((await lookup(h, company, existing.id)).body).toEqual({
      rooms: [{ roomId: room.id, title: "Pricing", status: "open", relation: "linked" }],
    });
    const none = await lookup(h, company, plain.id);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ rooms: [] });
  });

  it("lists every Room of the issue, oldest link first, and follows a closed Room's status and a title change", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const first = await openRoom(h, company, "First");
    const second = await openRoom(h, company, "Second");
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Shared" });
    await insertWorkLink(h.ctx.db, company.id, { roomId: first.id, issueId: issue.id, relation: "linked", byUserId: company.members.owner.userId });
    await insertWorkLink(h.ctx.db, company.id, { roomId: second.id, issueId: issue.id, relation: "created", byUserId: company.members.owner.userId });
    await h.sql("UPDATE plugin_boardroom_79f8e138fc.rooms SET status = 'closed', closed_at = now(), title = 'Renamed' WHERE id = $1", [second.id]);

    const response = await lookup(h, company, issue.id);
    expect(response.body.rooms).toEqual([
      { roomId: first.id, title: "First", status: "open", relation: "linked" },
      { roomId: second.id, title: "Renamed", status: "closed", relation: "created" },
    ]);
  });

  it("drops the Room once the task is unlinked", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await h.request("POST", `/rooms/${room.id}/work-links`, { body: { companyId: company.id, issueId: issue.id }, actor: company.members.operator });
    expect((await lookup(h, company, issue.id)).body.rooms).toHaveLength(1);
    await h.request("DELETE", `/rooms/${room.id}/work-links/${issue.id}`, { query: { companyId: company.id }, actor: company.members.operator });
    expect((await lookup(h, company, issue.id)).body.rooms).toEqual([]);
  });

  it("never returns a Room of another company", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const stranger = await h.seedCompany();
    const mine = await openRoom(h, company, "Mine");
    const theirs = await openRoom(h, stranger, "Theirs");
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Mine" });
    const theirIssue = await h.ctx.issues.create({ companyId: stranger.id, title: "Theirs" });
    await insertWorkLink(h.ctx.db, company.id, { roomId: mine.id, issueId: issue.id, relation: "linked", byUserId: company.members.owner.userId });
    // A stranger-company row that names the same issue id must stay invisible to this company.
    await insertWorkLink(h.ctx.db, stranger.id, { roomId: theirs.id, issueId: issue.id, relation: "linked", byUserId: stranger.members.owner.userId });
    await insertWorkLink(h.ctx.db, stranger.id, { roomId: theirs.id, issueId: theirIssue.id, relation: "linked", byUserId: stranger.members.owner.userId });

    expect((await lookup(h, company, issue.id)).body.rooms.map((r) => r.title)).toEqual(["Mine"]);
    // Asking for the other company's issue as a member of this company is refused by the host (or answers nothing).
    const crossed = await lookup(h, company, theirIssue.id);
    expect(crossed.status === 404 || crossed.status === 403 || (crossed.status === 200 && crossed.body.rooms.length === 0)).toBe(true);
    expect(JSON.stringify(crossed.body)).not.toContain("Theirs");
  });

  it("answers an unknown issue id with an error or an empty list, never a Room", async () => {
    const h = await start();
    const company = await h.seedCompany();
    await openRoom(h, company);
    const response = await lookup(h, company, "11111111-1111-4111-8111-111111111111");
    expect(response.status === 200 ? (response.body as IssueRoomsResponse).rooms : []).toEqual([]);
    expect([200, 400, 404]).toContain(response.status);
  });

  it("lets a viewer call the lookup", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const room = await openRoom(h, company);
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "Existing" });
    await insertWorkLink(h.ctx.db, company.id, { roomId: room.id, issueId: issue.id, relation: "linked", byUserId: company.members.owner.userId });
    const response = await lookup(h, company, issue.id, "viewer");
    expect(response.status).toBe(200);
    expect(response.body.rooms).toHaveLength(1);
  });

  it("refuses an agent caller", async () => {
    const h = await start();
    const company = await h.seedCompany();
    const issue = await h.ctx.issues.create({ companyId: company.id, title: "x" });
    const response = await h.request("GET", `/issues/${issue.id}/rooms`, { actor: { type: "agent", agentId: company.agents[0]!.id, companyId: company.id } as never });
    expect([401, 403]).toContain(response.status);
  });
});
