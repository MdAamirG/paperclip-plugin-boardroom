import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage } from "../../src/ui/index.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { COMPANY_ID, LIST_PERMISSIONS, summaryFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi } from "../support/ui.js";

const listCalls = (api: ReturnType<typeof createMockApi>) => api.calls.filter((call) => call.method === "GET" && call.path === "/rooms");

function renderList(api: ReturnType<typeof createMockApi>) {
  return renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
}

describe("Room list", () => {
  it("lists the company's Rooms with status, Participant count and last activity", async () => {
    const api = createMockApi().on("GET", "/rooms", {
      rooms: [
        summaryFixture({ id: "r1", title: "Raise prices?", participantCount: 3, lastActivityAt: "2026-10-02T10:30:00.000Z" }),
        summaryFixture({ id: "r2", title: "Hire a CFO", status: "closed", participantCount: 5, lastActivityAt: "2026-09-20T08:00:00.000Z" }),
      ],
      permissions: LIST_PERMISSIONS.owner,
    });
    renderList(api);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);

    const first = within(rows[0]!);
    expect(first.getByRole("link", { name: "Raise prices?" })).toHaveAttribute("href", "/C1/boardroom/r1");
    expect(first.getByTestId("status-badge")).toHaveTextContent("Open");
    expect(first.getByText("3")).toBeInTheDocument();
    expect(first.getByText((_, element) => element?.tagName === "TIME")).toHaveAttribute("datetime", "2026-10-02T10:30:00.000Z");

    const second = within(rows[1]!);
    expect(second.getByTestId("status-badge")).toHaveTextContent("Closed");
    expect(second.getByText("5")).toBeInTheDocument();

    expect(api.calls[0]).toMatchObject({ method: "GET", path: "/rooms", query: { companyId: COMPANY_ID } });
    expect(screen.getByRole("link", { name: "New Room" })).toHaveAttribute("href", "/C1/boardroom/new");
  });

  it("opens a Room through host navigation", async () => {
    const api = createMockApi().on("GET", "/rooms", { rooms: [summaryFixture({ id: "r1" })], permissions: LIST_PERMISSIONS.owner });
    renderList(api);

    fireEvent.click(await screen.findByRole("link", { name: "Raise prices?" }));
    expect(sdkUi.navigations).toEqual(["/C1/boardroom/r1"]);
  });

  it("shows a loading state first", () => {
    renderList(createMockApi().on("GET", "/rooms", () => new Promise(() => {})));
    expect(screen.getByText("Loading Rooms…")).toBeInTheDocument();
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
  });

  it("shows an empty state with a New Room action", async () => {
    renderList(createMockApi().on("GET", "/rooms", { rooms: [], permissions: LIST_PERMISSIONS.owner }));

    expect(await screen.findByText("No Rooms yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "New Room" }));
    expect(sdkUi.navigations).toEqual(["/C1/boardroom/new"]);
  });

  it("shows no New Room action to a viewer, in the empty state or with Rooms", async () => {
    const empty = renderList(createMockApi().on("GET", "/rooms", { rooms: [], permissions: LIST_PERMISSIONS.viewer }));
    expect(await screen.findByText("No Rooms yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New Room" })).not.toBeInTheDocument();
    expect(screen.getByText(/can read Rooms but not create them/)).toBeInTheDocument();
    empty.unmount();

    renderList(createMockApi().on("GET", "/rooms", { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.viewer }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New Room" })).not.toBeInTheDocument();
  });

  it("shows the server's error, not an empty page, when the load fails, and retries", async () => {
    let fail = true;
    const api = createMockApi().on("GET", "/rooms", () => {
      if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "The database is unavailable" });
      return { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.owner };
    });
    renderList(api);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load Rooms");
    expect(alert).toHaveTextContent("The database is unavailable");
    expect(screen.queryByText("No Rooms yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New Room" })).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches when any Room changes, and ignores other events", async () => {
    let title = "Raise prices?";
    const api = createMockApi().on("GET", "/rooms", () => ({ rooms: [summaryFixture({ title })], permissions: LIST_PERMISSIONS.owner }));
    renderList(api);
    await screen.findByRole("link", { name: "Raise prices?" });
    expect(listCalls(api)).toHaveLength(1);
    expect(sdkUi.state.streamOptions.get("boardroom")).toEqual({ companyId: COMPANY_ID });

    act(() => sdkUi.pushStreamEvent("boardroom", { type: "something.else", roomId: "r9", companyId: COMPANY_ID }));
    expect(listCalls(api)).toHaveLength(1);

    title = "Raise prices by 5%?";
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "some-other-room", companyId: COMPANY_ID }));
    expect(await screen.findByRole("link", { name: "Raise prices by 5%?" })).toBeInTheDocument();
    expect(listCalls(api)).toHaveLength(2);

    // A refetch keeps the table on screen instead of flashing a spinner.
    expect(screen.queryByText("Loading Rooms…")).not.toBeInTheDocument();
  });

  it("keeps the old table and shows the error when a live refetch fails", async () => {
    let fail = false;
    const api = createMockApi().on("GET", "/rooms", () => {
      if (fail) throw new BoardroomApiError(503, { error: "unavailable", message: "Try again soon" });
      return { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.owner };
    });
    renderList(api);
    await screen.findByRole("table");

    fail = true;
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "r1", companyId: COMPANY_ID }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again soon");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("refetches once per event and not on unrelated re-renders", async () => {
    const api = createMockApi().on("GET", "/rooms", { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.owner });
    renderList(api);
    await screen.findByRole("table");
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "r1", companyId: COMPANY_ID }));
    await waitFor(() => expect(listCalls(api)).toHaveLength(2));
    // An unrelated re-render (location change within the list) does not refetch.
    act(() => sdkUi.setLocation("/C1/boardroom"));
    expect(listCalls(api)).toHaveLength(2);
  });

  it("keeps refetching after the host resets the stream's event list (a reconnect)", async () => {
    const api = createMockApi().on("GET", "/rooms", { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.owner });
    renderList(api);
    await screen.findByRole("table");
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "r1", companyId: COMPANY_ID }));
    await waitFor(() => expect(listCalls(api)).toHaveLength(2));

    // The host's hook starts a fresh list on reconnect; the first event of the new list must still count.
    act(() => {
      sdkUi.state.streams.set("boardroom", []);
      sdkUi.setLocation("/C1/boardroom");
    });
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "r1", companyId: COMPANY_ID }));
    await waitFor(() => expect(listCalls(api)).toHaveLength(3));
  });
});
