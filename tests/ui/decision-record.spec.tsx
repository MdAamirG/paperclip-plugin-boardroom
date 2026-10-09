import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecisionView, RoomDetail } from "../../src/api/types.js";
import { BoardroomApiError, BoardroomApiProvider } from "../../src/ui/api.js";
import { BoardroomPage } from "../../src/ui/index.js";
import { DecisionRecordRegion } from "../../src/ui/regions/decision-record.js";
import { COMPANY_ID, detailFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const DECISION_PATH = "/rooms/room-1/decision";
const ROOM_PATH = "/rooms/room-1";

const decisionFixture = (overrides: Partial<DecisionView> = {}): DecisionView => ({
  markdown: "# Raise prices\n\nBy 10 percent.",
  writer: { userId: "user-owner-1", name: null },
  at: "2026-10-03T12:00:00.000Z",
  ...overrides,
});

function withDecision(decision: DecisionView | null, overrides: Parameters<typeof detailFixture>[0] = {}): RoomDetail {
  return detailFixture({
    ...overrides,
    decision,
    room: { ...overrides.room, decisionMd: decision?.markdown ?? null, decisionByUserId: decision?.writer.userId ?? null, decisionAt: decision?.at ?? null },
  });
}

function renderRegion(detail: RoomDetail, api: MockBoardroomApi = createMockApi()) {
  const reloadRoom = vi.fn();
  const view = renderWithBoardroom(
    () => <DecisionRecordRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={reloadRoom} />,
    { api },
  );
  return { ...view, api, reloadRoom };
}

const region = () => within(document.querySelector<HTMLElement>('[data-region="decision-record"]')!);
const editor = () => screen.getByTestId("markdown-editor") as HTMLTextAreaElement;

describe("Decision record panel", () => {
  it("renders the record with MarkdownBlock and who wrote it and when", () => {
    renderRegion(withDecision(decisionFixture()));
    expect(screen.getByRole("heading", { level: 2, name: "Decision record" })).toBeInTheDocument();
    expect(region().getByTestId("markdown-block")).toHaveTextContent("# Raise prices By 10 percent.");
    const note = region().getByText(/Recorded by/);
    expect(note).toHaveTextContent("Recorded by You,");
    expect(note.querySelector("time")).toHaveAttribute("datetime", "2026-10-03T12:00:00.000Z");
    expect(note.querySelector("time")!.textContent).not.toBe("");
  });

  it("names another writer by display name, or by short id when the host gives no name", () => {
    const { unmount } = renderRegion(withDecision(decisionFixture({ writer: { userId: "user-admin-2", name: "Ada Admin" } })));
    expect(region().getByText(/Recorded by/)).toHaveTextContent("Recorded by Ada Admin,");
    unmount();
    renderRegion(withDecision(decisionFixture({ writer: { userId: "abcdef12-3456-7890-abcd-ef1234567890", name: null } })));
    expect(region().getByText(/Recorded by/)).toHaveTextContent("Recorded by Board user abcdef12,");
  });

  it("shows the Edit action only with control, and no editor to a reader", () => {
    const { unmount } = renderRegion(withDecision(decisionFixture()));
    expect(region().getByRole("button", { name: "Edit" })).toBeInTheDocument();
    unmount();

    renderRegion(withDecision(decisionFixture(), { permissions: { role: "operator", canPost: true, canControl: false } }));
    expect(region().getByTestId("markdown-block")).toBeInTheDocument();
    expect(region().queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an empty state that invites someone with control to record one", () => {
    const { unmount } = renderRegion(withDecision(null));
    expect(region().getByText(/No decision is recorded yet\. Write down what this Room decided/)).toBeInTheDocument();
    expect(region().getByRole("button", { name: "Record decision" })).toBeInTheDocument();
    expect(region().queryByTestId("markdown-block")).not.toBeInTheDocument();
    unmount();

    renderRegion(withDecision(null, { permissions: { role: "viewer", canPost: false, canControl: false } }));
    expect(region().getByText(/No decision is recorded yet\. The Room Owner or a company admin/)).toBeInTheDocument();
    expect(region().queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the editor on the current text with Cancel on the left and Save on the right", () => {
    renderRegion(withDecision(decisionFixture()));
    fireEvent.click(region().getByRole("button", { name: "Edit" }));
    expect(editor().value).toBe("# Raise prices\n\nBy 10 percent.");
    const footer = document.querySelector(".br-footer")!;
    const buttons = within(footer as HTMLElement).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it("Cancel drops the draft and shows the saved record again without any request", () => {
    const { api } = renderRegion(withDecision(decisionFixture()));
    fireEvent.click(region().getByRole("button", { name: "Edit" }));
    fireEvent.change(editor(), { target: { value: "Something else" } });
    fireEvent.click(region().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("markdown-editor")).not.toBeInTheDocument();
    expect(region().getByTestId("markdown-block")).toHaveTextContent("By 10 percent.");
    expect(api.calls).toEqual([]);
    // Editing again starts from the saved text, not the dropped draft.
    fireEvent.click(region().getByRole("button", { name: "Edit" }));
    expect(editor().value).toBe("# Raise prices\n\nBy 10 percent.");
  });

  it("Save sends the markdown, shows the answer at once and reloads the Room", async () => {
    const answer = withDecision(
      decisionFixture({ markdown: "New text", at: "2026-10-04T08:00:00.000Z" }),
      { room: { updatedAt: "2026-10-04T08:00:00.000Z" } },
    );
    const api = createMockApi().on("PATCH", DECISION_PATH, answer);
    const { reloadRoom } = renderRegion(withDecision(null), api);

    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    expect(region().getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(editor(), { target: { value: "New text" } });
    fireEvent.click(region().getByRole("button", { name: "Save" }));

    await waitFor(() => expect(region().getByTestId("markdown-block")).toHaveTextContent("New text"));
    expect(api.calls).toEqual([{ method: "PATCH", path: DECISION_PATH, query: undefined, body: { decisionMd: "New text", companyId: COMPANY_ID } }]);
    expect(reloadRoom).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("markdown-editor")).not.toBeInTheDocument();
    expect(region().getByText(/Recorded by/)).toBeInTheDocument();
  });

  it("saves with Ctrl+Enter in the editor", async () => {
    const api = createMockApi().on("PATCH", DECISION_PATH, withDecision(decisionFixture({ markdown: "Quick" }), { room: { updatedAt: "2026-10-04T08:00:00.000Z" } }));
    renderRegion(withDecision(null), api);
    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    fireEvent.change(editor(), { target: { value: "Quick" } });
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]!.body).toEqual({ decisionMd: "Quick", companyId: COMPANY_ID });
  });

  it("a failed save shows the error inline and keeps the draft, and a retry can succeed", async () => {
    let fail = true;
    const api = createMockApi().on("PATCH", DECISION_PATH, () => {
      if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "The request could not be completed" });
      return withDecision(decisionFixture({ markdown: "My draft" }), { room: { updatedAt: "2026-10-04T08:00:00.000Z" } });
    });
    const { reloadRoom } = renderRegion(withDecision(decisionFixture()), api);

    fireEvent.click(region().getByRole("button", { name: "Edit" }));
    fireEvent.change(editor(), { target: { value: "My draft" } });
    fireEvent.click(region().getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save the Decision record");
    expect(alert).toHaveTextContent("The request could not be completed");
    expect(editor().value).toBe("My draft");
    expect(region().getByRole("button", { name: "Save" })).toBeEnabled();
    expect(reloadRoom).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(region().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(region().getByTestId("markdown-block")).toHaveTextContent("My draft");
  });

  it("shows the server's 403 text when control was lost, keeping the draft", async () => {
    const api = createMockApi().on("PATCH", DECISION_PATH, () => {
      throw new BoardroomApiError(403, { error: "control_requires_owner_or_admin", message: "Only the Room Owner or a company owner or admin can do this" });
    });
    renderRegion(withDecision(null), api);
    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    fireEvent.change(editor(), { target: { value: "Draft" } });
    fireEvent.click(region().getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the Room Owner or a company owner or admin can do this");
    expect(editor().value).toBe("Draft");
  });

  it("clearing the text sends an empty string and warns first", async () => {
    const api = createMockApi().on("PATCH", DECISION_PATH, withDecision(null, { room: { updatedAt: "2026-10-04T08:00:00.000Z" } }));
    renderRegion(withDecision(decisionFixture()), api);
    fireEvent.click(region().getByRole("button", { name: "Edit" }));
    expect(region().queryByText(/removes the Decision record/)).not.toBeInTheDocument();
    fireEvent.change(editor(), { target: { value: "  " } });
    expect(region().getByText("Saving an empty text removes the Decision record.")).toBeInTheDocument();
    fireEvent.click(region().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(region().getByText(/No decision is recorded yet/)).toBeInTheDocument());
    expect(api.calls[0]!.body).toEqual({ decisionMd: "  ", companyId: COMPANY_ID });
  });

  it("disables both buttons while saving", async () => {
    let release!: (value: RoomDetail) => void;
    const api = createMockApi().on("PATCH", DECISION_PATH, () => new Promise<RoomDetail>((resolve) => (release = resolve)));
    renderRegion(withDecision(null), api);
    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    fireEvent.change(editor(), { target: { value: "x" } });
    fireEvent.click(region().getByRole("button", { name: "Save" }));
    expect(await region().findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(region().getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => release(withDecision(decisionFixture({ markdown: "x" }), { room: { updatedAt: "2026-10-04T08:00:00.000Z" } })));
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).not.toBeInTheDocument());
  });

  it("keeps the draft when the Room refreshes underneath the editor", () => {
    const api = createMockApi();
    const { rerender } = renderRegion(withDecision(null), api);
    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    fireEvent.change(editor(), { target: { value: "Half written" } });
    rerender(
      <BoardroomApiProvider api={api}>
        <DecisionRecordRegion
          companyId={COMPANY_ID}
          detail={withDecision(decisionFixture({ markdown: "Someone else" }), { room: { updatedAt: "2026-10-05T00:00:00.000Z" } })}
          refreshKey={1}
          reloadRoom={() => {}}
        />
      </BoardroomApiProvider>,
    );
    expect(editor().value).toBe("Half written");
  });
});

describe("Decision record on the Room page", () => {
  function renderPage(api: MockBoardroomApi) {
    sdkUi.setLocation("/C1/boardroom/room-1");
    return renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
  }

  it("loads the record with the Room, saves it and refetches the Room", async () => {
    let detail = withDecision(null);
    const api = createMockApi().on("GET", ROOM_PATH, () => detail);
    api.on("PATCH", DECISION_PATH, () => {
      detail = withDecision(decisionFixture({ markdown: "Final call" }), { room: { updatedAt: "2026-10-04T08:00:00.000Z" } });
      return detail;
    });
    renderPage(api);

    await screen.findByRole("heading", { level: 1, name: "Raise prices?" });
    fireEvent.click(region().getByRole("button", { name: "Record decision" }));
    fireEvent.change(editor(), { target: { value: "Final call" } });
    fireEvent.click(region().getByRole("button", { name: "Save" }));

    await waitFor(() => expect(region().getByTestId("markdown-block")).toHaveTextContent("Final call"));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "GET" && c.path === ROOM_PATH)).toHaveLength(2));
    expect(api.calls.find((c) => c.method === "PATCH")).toMatchObject({ body: { decisionMd: "Final call", companyId: COMPANY_ID } });
  });

  it("a viewer reads the record and has no Edit action", async () => {
    const api = createMockApi().on(
      "GET",
      ROOM_PATH,
      withDecision(decisionFixture(), { permissions: { role: "viewer", canPost: false, canControl: false } }),
    );
    renderPage(api);
    await screen.findByRole("heading", { level: 1, name: "Raise prices?" });
    expect(region().getByTestId("markdown-block")).toHaveTextContent("By 10 percent.");
    expect(region().queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});
