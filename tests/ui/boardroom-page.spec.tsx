import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage, BoardroomSidebarLink } from "../../src/ui/index.js";
import { agentFixture, detailFixture, LIST_PERMISSIONS, summaryFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi } from "../support/ui.js";

function api() {
  return createMockApi()
    .on("GET", "/rooms", { rooms: [summaryFixture()], permissions: LIST_PERMISSIONS.owner })
    .on("GET", "/rooms/room-1", detailFixture())
    .on("GET", "host:/companies/company-1/agents", [agentFixture("Ada")]);
}

describe("Boardroom page routes", () => {
  it("shows the Room list at /boardroom", async () => {
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: api() });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Boardroom" })).toBeInTheDocument();
  });

  it("shows the creation flow at /boardroom/new and the Room at /boardroom/:roomId", async () => {
    sdkUi.setLocation("/C1/boardroom/new");
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: api() });
    expect(await screen.findByRole("heading", { name: "New Room" })).toBeInTheDocument();

    act(() => sdkUi.setLocation("/C1/boardroom/room-1"));
    expect(await screen.findByRole("heading", { level: 1, name: "Raise prices?" })).toBeInTheDocument();

    act(() => sdkUi.setLocation("/C1/boardroom"));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("goes from the list to a Room through the host router, and back", async () => {
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: api() });
    fireEvent.click(await screen.findByRole("link", { name: "Raise prices?" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Raise prices?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "← All Rooms" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(sdkUi.navigations).toEqual(["/C1/boardroom/room-1", "/C1/boardroom"]);
  });

  it("says when the address matches nothing", () => {
    sdkUi.setLocation("/C1/boardroom/room-1/extra");
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: api() });
    expect(screen.getByRole("alert")).toHaveTextContent("This Boardroom address does not exist.");
    expect(screen.getByRole("link", { name: "← All Rooms" })).toBeInTheDocument();
  });

  it("asks for a company when none is selected, and calls no API", () => {
    const mock = api();
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: mock, hostContext: { companyId: null, companyPrefix: null } });
    expect(screen.getByText(/select a company/i)).toBeInTheDocument();
    expect(mock.calls).toEqual([]);
  });

  it("is a labelled region the host can navigate to", () => {
    renderWithBoardroom((ctx) => <BoardroomPage context={ctx} />, { api: api() });
    expect(screen.getByRole("region", { name: "Boardroom" })).toBeInTheDocument();
  });
});

describe("Boardroom sidebar entry", () => {
  it("links to the company's Boardroom route through host navigation", () => {
    renderWithBoardroom((ctx) => <BoardroomSidebarLink context={ctx} />, { hostContext: { companyPrefix: "ACME" } });

    const link = screen.getByRole("link", { name: "Boardroom" });
    expect(link).toHaveAttribute("href", "/ACME/boardroom");
    expect(link).not.toHaveAttribute("aria-current");
    fireEvent.click(link);
    expect(sdkUi.navigations).toEqual(["/ACME/boardroom"]);
  });

  it("is marked current on the Boardroom page and on a Room", () => {
    sdkUi.setLocation("/C1/boardroom/room-1");
    renderWithBoardroom((ctx) => <BoardroomSidebarLink context={ctx} />);
    expect(screen.getByRole("link", { name: "Boardroom" })).toHaveAttribute("aria-current", "page");
  });
});
