import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { IssueRoomView } from "../../src/api/types.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { FromRoomChip } from "../../src/ui/index.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const ISSUE = "issue-7";
const PATH = `/issues/${ISSUE}/rooms`;

function room(overrides: Partial<IssueRoomView> = {}): IssueRoomView {
  return { roomId: "room-1", title: "Raise prices?", status: "open", relation: "created", ...overrides };
}

function renderChip(api: MockBoardroomApi) {
  return renderWithBoardroom((ctx) => <FromRoomChip context={ctx} />, {
    api,
    hostContext: { entityId: ISSUE, entityType: "issue" },
  });
}

describe("From Room chip", () => {
  it("renders nothing for an issue with no work link, and nothing while loading", async () => {
    let release: (value: unknown) => void = () => {};
    const api = createMockApi().on("GET", PATH, () => new Promise((resolve) => { release = resolve; }));
    const { container } = renderChip(api);
    expect(container).toBeEmptyDOMElement();
    release({ rooms: [] });
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders 'From Room: <title>' for one link and opens the Room through host navigation", async () => {
    const api = createMockApi().on("GET", PATH, { rooms: [room()] });
    renderChip(api);
    const chip = await screen.findByRole("link", { name: "From Room: Raise prices?" });
    expect(chip).toHaveAttribute("href", "/C1/boardroom/room-1");
    expect(screen.queryByRole("button", { name: /more linked/i })).toBeNull();
    fireEvent.click(chip);
    expect(sdkUi.navigations).toEqual(["/C1/boardroom/room-1"]);
    expect(api.calls[0]).toMatchObject({ method: "GET", path: PATH });
  });

  it("renders the first Room with '+1' for two links and lists both Rooms", async () => {
    const api = createMockApi().on("GET", PATH, { rooms: [room(), room({ roomId: "room-2", title: "Hiring", relation: "linked" })] });
    renderChip(api);
    expect(await screen.findByRole("link", { name: "From Room: Raise prices?" })).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "1 more linked Rooms" });
    expect(more).toHaveTextContent("+1");
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByRole("link", { name: "Hiring" })).toHaveAttribute("href", "/C1/boardroom/room-2");
    expect(screen.getByRole("link", { name: "Raise prices?" })).toHaveAttribute("href", "/C1/boardroom/room-1");
    fireEvent.click(screen.getByRole("link", { name: "Hiring" }));
    expect(sdkUi.navigations).toEqual(["/C1/boardroom/room-2"]);
  });

  it("shows a small error state when the lookup fails, and retries", async () => {
    let fail = true;
    const api = createMockApi().on("GET", PATH, () => {
      if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "The request could not be completed" });
      return { rooms: [room()] };
    });
    renderChip(api);
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("From Room: unavailable");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the linked Room" }));
    expect(await screen.findByRole("link", { name: "From Room: Raise prices?" })).toBeInTheDocument();
  });

  it("does nothing outside an issue page", () => {
    const api = createMockApi();
    const { container } = renderWithBoardroom((ctx) => <FromRoomChip context={ctx} />, {
      api,
      hostContext: { entityId: "project-1", entityType: "project" },
    });
    expect(container).toBeEmptyDOMElement();
    expect(api.calls).toEqual([]);
  });
});
