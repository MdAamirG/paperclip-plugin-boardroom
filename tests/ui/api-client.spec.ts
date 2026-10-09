import { describe, expect, it, vi } from "vitest";
import { ROUTE_SPECS } from "../../src/api/route-table.js";
import { BoardroomApiError, createBoardroomApi, createBoardroomClient, listCompanyAgents, searchCompanyIssues } from "../../src/ui/api.js";

const BASE = "/api/plugins/mdaamirg.boardroom/api";

function recorder(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  return { fetchMock, api: createBoardroomApi({ fetch: fetchMock }) };
}

function lastCall(fetchMock: ReturnType<typeof recorder>["fetchMock"]) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe("BoardroomApiError", () => {
  it("carries the plugin's error code, message and details", async () => {
    const { api } = recorder(422, { error: "turn_cap_out_of_range", message: "The turn cap must be a whole number from 1 to 200", details: { min: 1, max: 200 } });
    const failure = await api.post("/rooms", {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BoardroomApiError);
    expect(failure).toMatchObject({
      status: 422,
      code: "turn_cap_out_of_range",
      message: "The turn cap must be a whole number from 1 to 200",
      details: { min: 1, max: 200 },
    });
  });

  it("uses the host's text when the reply has no message, and a fallback for an empty body", async () => {
    expect(new BoardroomApiError(403, { error: "Forbidden" })).toMatchObject({ code: "Forbidden", message: "Forbidden" });
    expect(new BoardroomApiError(502, null)).toMatchObject({ code: null, message: "Boardroom request failed with status 502" });
  });

  it("keeps a non-JSON error body as the message", async () => {
    const fetchMock = vi.fn(async () => new Response("Bad gateway", { status: 502 }));
    const failure = await createBoardroomApi({ fetch: fetchMock }).get("/rooms").catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 502, message: "Bad gateway" });
  });
});

describe("host API calls", () => {
  it("go to /api with credentials and the query string", async () => {
    const { api, fetchMock } = recorder(200, []);
    await listCompanyAgents(api, "c 1");
    expect(lastCall(fetchMock)).toMatchObject({ url: "/api/companies/c%201/agents", method: "GET" });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: "include" });

    await searchCompanyIssues(api, "c1", "price", 5);
    expect(lastCall(fetchMock).url).toBe("/api/companies/c1/issues?q=price&limit=5");
  });
});

describe("BoardroomClient", () => {
  it("has one function per declared route, each calling that route's method and path with the company id", async () => {
    const { api, fetchMock } = recorder();
    const client = createBoardroomClient(api, "c1");
    const room = "r1";
    const calls: Array<[string, () => Promise<unknown>, { method: string; url: string; body?: unknown }]> = [
      ["rooms.list", () => client.listRooms(), { method: "GET", url: `${BASE}/rooms?companyId=c1` }],
      ["rooms.create", () => client.createRoom({ title: "T", topic: "P", agentIds: ["a"] }), { method: "POST", url: `${BASE}/rooms`, body: { title: "T", topic: "P", agentIds: ["a"], companyId: "c1" } }],
      ["rooms.get", () => client.getRoom(room), { method: "GET", url: `${BASE}/rooms/r1?companyId=c1` }],
      ["rooms.update", () => client.updateRoom(room, { title: "N" }), { method: "PATCH", url: `${BASE}/rooms/r1`, body: { title: "N", companyId: "c1" } }],
      ["participants.add", () => client.addParticipant(room, "a1"), { method: "POST", url: `${BASE}/rooms/r1/participants`, body: { agentId: "a1", companyId: "c1" } }],
      ["participants.remove", () => client.removeParticipant(room, "a1"), { method: "DELETE", url: `${BASE}/rooms/r1/participants/a1?companyId=c1` }],
      ["messages.list", () => client.listMessages(room), { method: "GET", url: `${BASE}/rooms/r1/messages?companyId=c1` }],
      ["messages.send", () => client.sendMessage(room, { body: "hi" }), { method: "POST", url: `${BASE}/rooms/r1/messages`, body: { body: "hi", companyId: "c1" } }],
      ["rounds.list", () => client.listRounds(room), { method: "GET", url: `${BASE}/rooms/r1/rounds?companyId=c1` }],
      ["costs.get", () => client.getCosts(room), { method: "GET", url: `${BASE}/rooms/r1/costs?companyId=c1` }],
      ["rounds.pause", () => client.pauseRound(room, "x1"), { method: "POST", url: `${BASE}/rooms/r1/rounds/x1/pause`, body: { companyId: "c1" } }],
      ["rounds.resume", () => client.resumeRound(room, "x1"), { method: "POST", url: `${BASE}/rooms/r1/rounds/x1/resume`, body: { companyId: "c1" } }],
      ["rounds.stop", () => client.stopRound(room, "x1"), { method: "POST", url: `${BASE}/rooms/r1/rounds/x1/stop`, body: { companyId: "c1" } }],
      ["rooms.close", () => client.closeRoom(room), { method: "POST", url: `${BASE}/rooms/r1/close`, body: { companyId: "c1" } }],
      ["decision.update", () => client.updateDecision(room, { decisionMd: "Go" }), { method: "PATCH", url: `${BASE}/rooms/r1/decision`, body: { decisionMd: "Go", companyId: "c1" } }],
      ["work.create", () => client.createWork(room, { title: "Do it" }), { method: "POST", url: `${BASE}/rooms/r1/work`, body: { title: "Do it", companyId: "c1" } }],
      ["work-links.add", () => client.addWorkLink(room, { issueId: "i1" }), { method: "POST", url: `${BASE}/rooms/r1/work-links`, body: { issueId: "i1", companyId: "c1" } }],
      ["work-links.remove", () => client.removeWorkLink(room, "i1"), { method: "DELETE", url: `${BASE}/rooms/r1/work-links/i1?companyId=c1` }],
      ["issues.rooms", () => client.listRoomsForIssue("i1"), { method: "GET", url: `${BASE}/issues/i1/rooms` }],
    ];

    // Every declared route has a client function, and the table is the same as the route table.
    expect(calls.map(([key]) => key).sort()).toEqual(ROUTE_SPECS.map((spec) => spec.routeKey).sort());

    for (const [key, invoke, expected] of calls) {
      await invoke();
      const actual = lastCall(fetchMock);
      const spec = ROUTE_SPECS.find((s) => s.routeKey === key)!;
      expect(actual.method, key).toBe(spec.method);
      expect(actual.method, key).toBe(expected.method);
      expect(actual.url, key).toBe(expected.url);
      expect(actual.body, key).toEqual(expected.body);
    }
  });

  it("escapes ids placed in a path", async () => {
    const { api, fetchMock } = recorder();
    await createBoardroomClient(api, "c1").getRoom("a/b");
    expect(lastCall(fetchMock).url).toBe(`${BASE}/rooms/a%2Fb?companyId=c1`);
  });
});
