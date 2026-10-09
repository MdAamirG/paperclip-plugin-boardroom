import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage } from "../../src/ui/index.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { COMPANY_ID, detailFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const ROOM_PATH = "/rooms/room-1";
const REGIONS = ["round-progress", "transcript", "composer", "participants", "cost", "follow-up-work", "decision-record"];

function renderRoom(api: MockBoardroomApi, roomId = "room-1") {
  // The transcript region loads its own data; these tests are about the shell, so every Room has an empty one.
  for (const id of ["room-1", "room-2"]) {
    api.on("GET", `/rooms/${id}/messages`, { messages: [], hasMore: false });
    api.on("GET", `/rooms/${id}/rounds`, { rounds: [] });
  }
  // The Participant panel (with control) loads the company's agents for its picker.
  api.on("GET", "host:/companies/company-1/agents", []);
  sdkUi.setLocation(`/C1/boardroom/${roomId}`);
  return renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
}

const region = (name: string) => document.querySelector<HTMLElement>(`[data-region="${name}"]`);
const getCalls = (api: MockBoardroomApi) => api.calls.filter((call) => call.method === "GET" && call.path === ROOM_PATH);

describe("Room detail shell", () => {
  it("shows the header, the Participants with names and roles, and a placeholder for every later region", async () => {
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ room: { maxTotalTurns: 60, projectId: "project-7" } }));
    api.on("GET", "host:/projects/project-7", { id: "project-7", name: "Growth" });
    renderRoom(api);

    expect(await screen.findByRole("heading", { level: 1, name: "Raise prices?" })).toBeInTheDocument();
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Open");
    expect(screen.getByTestId("markdown-block")).toHaveTextContent("Should we raise prices by 10 percent next quarter?");
    const meta = screen.getByText("Owner").closest("dl")!;
    expect(within(meta).getByText("You")).toBeInTheDocument();
    expect(await within(meta).findByText("Growth")).toBeInTheDocument();
    expect(within(meta).getByText("60")).toBeInTheDocument();

    const participants = within(region("participants")!);
    const items = participants.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Ada");
    expect(items[0]).toHaveTextContent("cto · Chief Technology Officer");
    expect(items[1]).toHaveTextContent("Grace");
    expect(items[1]).toHaveTextContent("engineer");

    for (const name of REGIONS) expect(region(name), name).toBeInTheDocument();
    for (const heading of ["Round progress", "Transcript", "Composer", "Participants", "Cost", "Follow-up work", "Decision record"]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    expect(api.calls[0]).toMatchObject({ method: "GET", path: ROOM_PATH, query: { companyId: COMPANY_ID } });
  });

  it("shows another owner by id and a removed agent without crashing", async () => {
    const detail = detailFixture({
      room: { ownerUserId: "abcdef12-3456-7890-abcd-ef1234567890" },
      participants: [{ id: "p1", agentId: "11111111-2222-3333-4444-555555555555", name: null, role: null, title: null, addedByUserId: "u", addedAt: "2026-10-01T09:00:00.000Z" }],
    });
    renderRoom(createMockApi().on("GET", ROOM_PATH, detail));

    expect(await screen.findByText("Board user abcdef12")).toBeInTheDocument();
    expect(screen.getByText("Removed agent (11111111)")).toBeInTheDocument();
  });

  it("falls back to the project id and says why when the project name cannot be loaded", async () => {
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ room: { projectId: "project-7-uuid" } }));
    api.on("GET", "host:/projects/project-7-uuid", () => {
      throw new BoardroomApiError(404, { error: "Project not found" });
    });
    renderRoom(api);
    expect(await screen.findByText(/name unavailable: Project not found/)).toBeInTheDocument();
  });

  it("lets an owner or operator see the composer region, and shows a read-only notice to a viewer", async () => {
    const owner = renderRoom(createMockApi().on("GET", ROOM_PATH, detailFixture()));
    await screen.findByRole("heading", { level: 1 });
    expect(within(region("composer")!).getByRole("textbox", { name: /Message/ })).toBeInTheDocument();
    owner.unmount();

    renderRoom(createMockApi().on("GET", ROOM_PATH, detailFixture({ permissions: { role: "viewer", canPost: false, canControl: false } })));
    await screen.findByRole("heading", { level: 1 });
    const composer = within(region("composer")!);
    expect(composer.queryByRole("textbox")).not.toBeInTheDocument();
    expect(composer.getByRole("status")).toHaveTextContent("Your role can read this Room but not post in it.");
  });

  it("shows a closed Room as closed and read-only", async () => {
    const detail = detailFixture({
      room: { status: "closed", closedAt: "2026-10-03T12:00:00.000Z" },
      permissions: { role: "owner", canPost: false, canControl: true },
    });
    renderRoom(createMockApi().on("GET", ROOM_PATH, detail));

    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Closed");
    expect(screen.getByText("Closed", { selector: "dt" })).toBeInTheDocument();
    expect(within(region("composer")!).getByRole("status")).toHaveTextContent("This Room is closed, so it is read-only.");
  });

  it("shows the server's error, not an empty page, when the Room does not load, and retries", async () => {
    let fail = true;
    const api = createMockApi().on("GET", ROOM_PATH, () => {
      if (fail) throw new BoardroomApiError(404, { error: "room_not_found", message: "That Room does not exist in this company" });
      return detailFixture();
    });
    renderRoom(api);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this Room");
    expect(alert).toHaveTextContent("That Room does not exist in this company");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← All Rooms" })).toHaveAttribute("href", "/C1/boardroom");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Raise prices?" })).toBeInTheDocument();
  });

  it("shows a loading state first", () => {
    renderRoom(createMockApi().on("GET", ROOM_PATH, () => new Promise(() => {})));
    expect(screen.getByText("Loading Room…")).toBeInTheDocument();
  });

  it("refetches on room.changed for the open Room only", async () => {
    let title = "Raise prices?";
    const api = createMockApi().on("GET", ROOM_PATH, () => detailFixture({ room: { title } }));
    renderRoom(api);
    await screen.findByRole("heading", { level: 1, name: "Raise prices?" });
    expect(getCalls(api)).toHaveLength(1);
    expect(sdkUi.state.streamOptions.get("boardroom")).toEqual({ companyId: COMPANY_ID });

    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "another-room", companyId: COMPANY_ID }));
    expect(getCalls(api)).toHaveLength(1);

    title = "Raise prices next quarter?";
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "room-1", companyId: COMPANY_ID }));
    expect(await screen.findByRole("heading", { level: 1, name: "Raise prices next quarter?" })).toBeInTheDocument();
    expect(getCalls(api)).toHaveLength(2);
    expect(screen.queryByText("Loading Room…")).not.toBeInTheDocument();
  });

  it("keeps showing the Room and reports the error when a live refetch fails", async () => {
    let fail = false;
    const api = createMockApi().on("GET", ROOM_PATH, () => {
      if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "Something broke" });
      return detailFixture();
    });
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });

    fail = true;
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "room-1", companyId: COMPANY_ID }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke");
    expect(screen.getByRole("heading", { level: 1, name: "Raise prices?" })).toBeInTheDocument();
  });

  it("re-renders the regions from the refetched Room", async () => {
    let names = ["Ada"];
    const api = createMockApi().on("GET", ROOM_PATH, () =>
      detailFixture({
        participants: names.map((name, index) => ({ id: `p${index}`, agentId: `a${index}`, name, role: "engineer", title: null, addedByUserId: "u", addedAt: "2026-10-01T09:00:00.000Z" })),
      }),
    );
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });
    expect(within(region("participants")!).getAllByRole("listitem")).toHaveLength(1);

    names = ["Ada", "Grace"];
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "room-1", companyId: COMPANY_ID }));
    expect(await within(region("participants")!).findByText("Grace")).toBeInTheDocument();
  });

  it("loads the new Room when the address moves to another Room", async () => {
    const api = createMockApi()
      .on("GET", "/rooms/room-1", detailFixture({ room: { id: "room-1", title: "First" } }))
      .on("GET", "/rooms/room-2", detailFixture({ room: { id: "room-2", title: "Second" } }));
    renderRoom(api);
    expect(await screen.findByRole("heading", { level: 1, name: "First" })).toBeInTheDocument();

    act(() => sdkUi.setLocation("/C1/boardroom/room-2"));
    expect(await screen.findByRole("heading", { level: 1, name: "Second" })).toBeInTheDocument();
  });
});
