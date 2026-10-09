import type { ReactElement } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoomDetail } from "../../src/api/types.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { ComposerRegion } from "../../src/ui/regions/composer.js";
import { ParticipantsRegion } from "../../src/ui/regions/participants.js";
import { RoomSettingsRegion } from "../../src/ui/regions/room-settings.js";
import { RoomDetailPage } from "../../src/ui/components/RoomDetail.js";
import { COMPANY_ID, agentFixture, detailFixture, roundFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, type MockBoardroomApi } from "../support/ui.js";

const ROOM = "/rooms/room-1";
const AGENTS = "host:/companies/company-1/agents";
const agents = [agentFixture("Ada"), agentFixture("Grace"), agentFixture("Linus"), agentFixture("Ken", { status: "terminated" })].map((a, i) =>
  i === 0 ? { ...a, id: "agent-1" } : i === 1 ? { ...a, id: "agent-2" } : a,
);

function render(ui: (props: { detail: RoomDetail; reloadRoom: () => void }) => ReactElement, detail: RoomDetail, api: MockBoardroomApi = createMockApi()) {
  const reloadRoom = vi.fn();
  const view = renderWithBoardroom(() => ui({ detail, reloadRoom }), { api });
  return { ...view, api, reloadRoom };
}
const participants = (detail: RoomDetail, api = createMockApi().on("GET", AGENTS, agents)) =>
  render((p) => <ParticipantsRegion companyId={COMPANY_ID} detail={p.detail} refreshKey={0} reloadRoom={p.reloadRoom} />, detail, api);
const settings = (detail: RoomDetail, api = createMockApi()) =>
  render((p) => <RoomSettingsRegion companyId={COMPANY_ID} detail={p.detail} refreshKey={0} reloadRoom={p.reloadRoom} />, detail, api);

const activeRound = () => roundFixture({ status: "running" });

describe("Participant panel", () => {
  it("lists Participants without edit controls for a user without control", async () => {
    participants(detailFixture({ permissions: { role: "operator", canPost: true, canControl: false } }));
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText("Add an agent")).toBeNull();
  });

  it("hides edit controls in a closed Room", () => {
    participants(detailFixture({ room: { status: "closed", closedAt: "2026-10-02T00:00:00.000Z" } }));
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText("Add an agent")).toBeNull();
  });

  it("offers only company agents who are not active (and not terminated), and adds the picked one", async () => {
    const api = createMockApi().on("GET", AGENTS, agents).on("POST", `${ROOM}/participants`, detailFixture());
    const { reloadRoom } = participants(detailFixture(), api);
    const select = (await screen.findByLabelText("Add an agent")) as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Pick an agent", "Linus (engineer)"]);
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    fireEvent.change(select, { target: { value: "agent-linus" } });
    fireEvent.click(add);
    await waitFor(() => expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ agentId: "agent-linus", companyId: COMPANY_ID }));
    await waitFor(() => expect(reloadRoom).toHaveBeenCalled());
  });

  it("removes a Participant", async () => {
    const api = createMockApi().on("GET", AGENTS, agents).on("DELETE", `${ROOM}/participants/agent-2`, detailFixture());
    const { reloadRoom } = participants(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Remove Grace" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === `${ROOM}/participants/agent-2`)).toBe(true));
    await waitFor(() => expect(reloadRoom).toHaveBeenCalled());
  });

  it("blocks adding at eight and says why", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`, agentId: `a${i}`, name: `Agent ${i}`, role: "engineer", title: null, addedByUserId: "u", addedAt: "2026-10-01T09:00:00.000Z",
    }));
    participants(detailFixture({ participants: many }));
    expect(await screen.findByText(/at most 8 agents/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByLabelText("Add an agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Agent 0" })).not.toBeDisabled();
  });

  it("disables add and remove during a Round and shows the reason", async () => {
    participants(detailFixture({ activeRound: activeRound() }));
    expect(screen.getByRole("status")).toHaveTextContent("A Round is in progress");
    expect(screen.getByRole("button", { name: "Remove Ada" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText("Add an agent")).toBeDisabled());
  });

  it("shows the server's error inline", async () => {
    const api = createMockApi()
      .on("GET", AGENTS, agents)
      .on("DELETE", `${ROOM}/participants/agent-1`, () => {
        throw new BoardroomApiError(409, { error: "round_active", message: "A Round is in progress." });
      });
    const { reloadRoom } = participants(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A Round is in progress.");
    expect(reloadRoom).toHaveBeenCalled();
  });
});

describe("Room settings editor", () => {
  it("renders nothing for a user without control, and nothing in a closed Room", () => {
    const { container, unmount } = settings(detailFixture({ permissions: { role: "operator", canPost: true, canControl: false } }));
    expect(container.querySelector('[data-region="room-settings"]')).toBeNull();
    unmount();
    const closed = settings(detailFixture({ room: { status: "closed", closedAt: "2026-10-02T00:00:00.000Z" } }));
    expect(closed.container.querySelector('[data-region="room-settings"]')).toBeNull();
  });

  it("saves only the changed fields", async () => {
    const api = createMockApi().on("PATCH", ROOM, detailFixture());
    const { reloadRoom } = settings(detailFixture(), api);
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New title" } });
    fireEvent.change(screen.getByLabelText("Turn cap"), { target: { value: "12" } });
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "New title", maxTotalTurns: 12, companyId: COMPANY_ID }));
    await waitFor(() => expect(reloadRoom).toHaveBeenCalled());
  });

  it("validates the cap before sending", () => {
    const api = createMockApi();
    settings(detailFixture(), api);
    fireEvent.change(screen.getByLabelText("Turn cap"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByText("The turn cap is a whole number from 1 to 200.")).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it("is disabled during a Round with the reason", () => {
    settings(detailFixture({ activeRound: activeRound() }));
    for (const label of ["Title", "Topic", "Turn cap"]) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Room" })).toBeDisabled();
    expect(screen.getByText(/A Round is in progress/)).toBeInTheDocument();
  });

  it("keeps the draft and shows the error when the save fails", async () => {
    const api = createMockApi().on("PATCH", ROOM, () => {
      throw new BoardroomApiError(409, { error: "round_active", message: "A Round is in progress." });
    });
    settings(detailFixture(), api);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A Round is in progress.");
    expect(screen.getByLabelText("Title")).toHaveValue("Typed");
  });
});

describe("Close Room", () => {
  it("asks for confirmation, can be cancelled, and closes on confirm", async () => {
    const api = createMockApi().on("POST", `${ROOM}/close`, detailFixture());
    const { reloadRoom } = settings(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("takes no more messages");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.calls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close Room" }));
    await waitFor(() => expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ companyId: COMPANY_ID }));
    await waitFor(() => expect(reloadRoom).toHaveBeenCalled());
  });

  it("shows the error inline when closing fails", async () => {
    const api = createMockApi().on("POST", `${ROOM}/close`, () => {
      throw new BoardroomApiError(409, { error: "round_active", message: "A Round is in progress." });
    });
    settings(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close Room" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A Round is in progress.");
  });
});

describe("closed Room page", () => {
  it("shows the closed banner and disables the composer; edit panels are gone", async () => {
    const closed = detailFixture({
      room: { status: "closed", closedAt: "2026-10-02T00:00:00.000Z" },
      permissions: { role: "owner", canPost: false, canControl: true },
    });
    const api = createMockApi()
      .on("GET", ROOM, closed)
      .on("GET", `${ROOM}/messages`, { messages: [], hasMore: false })
      .on("GET", `${ROOM}/rounds`, { rounds: [] })
      .on("GET", AGENTS, agents);
    renderWithBoardroom(() => <RoomDetailPage companyId={COMPANY_ID} roomId="room-1" />, { api });
    expect(await screen.findByTestId("closed-banner")).toHaveTextContent("This Room is closed");
    expect(screen.getByText("This Room is closed, so it is read-only.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /message|note/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });
});

describe("composer in a closed Room", () => {
  it("has no send button", () => {
    const closed = detailFixture({ room: { status: "closed", closedAt: "2026-10-02T00:00:00.000Z" }, permissions: { role: "owner", canPost: false, canControl: true } });
    renderWithBoardroom(() => <ComposerRegion companyId={COMPANY_ID} detail={closed} refreshKey={0} reloadRoom={() => {}} />, { api: createMockApi() });
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });
});
