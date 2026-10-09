import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CreateWorkResponse, WorkIssueView, WorkLinkView } from "../../src/api/types.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { FollowUpWorkRegion } from "../../src/ui/regions/follow-up-work.js";
import { BoardroomPage } from "../../src/ui/index.js";
import { COMPANY_ID, detailFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

// The host provides AssigneePicker and MarkdownEditor at runtime; these stand-ins are queryable.
vi.mock("@paperclipai/plugin-sdk/ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("../support/sdk-ui-mock.js")>();
  return {
    ...original,
    AssigneePicker: ({ value, onChange, placeholder }: { value: string; onChange: (value: string, selection: unknown) => void; placeholder?: string }) => (
      <select
        aria-label={placeholder ?? "Assignee"}
        value={value}
        onChange={(event) => {
          const [kind, id] = event.target.value.split(":");
          onChange(event.target.value, { assigneeAgentId: kind === "agent" ? id : null, assigneeUserId: kind === "user" ? id : null });
        }}
      >
        <option value="">No assignee</option>
        <option value="agent:agent-1">Ada</option>
        <option value="user:user-9">Board member</option>
      </select>
    ),
    MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
      <textarea aria-label="Plan editor" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    ),
  };
});

const ROOM = "room-1";
const WORK = `/rooms/${ROOM}/work`;
const LINKS = `/rooms/${ROOM}/work-links`;
const ROOM_PATH = `/rooms/${ROOM}`;

function issueView(overrides: Partial<WorkIssueView> = {}): WorkIssueView {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Raise prices",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent-1",
    assigneeAgentName: "Ada",
    assigneeUserId: null,
    projectId: null,
    ...overrides,
  };
}

function linkView(overrides: Partial<WorkLinkView> = {}): WorkLinkView {
  return {
    id: "link-1",
    companyId: COMPANY_ID,
    roomId: ROOM,
    issueId: "issue-1",
    relation: "created",
    byUserId: "user-owner-1",
    createdAt: "2026-10-02T10:00:00.000Z",
    issue: issueView(),
    ...overrides,
  };
}

function renderRegion(detail = detailFixture(), api: MockBoardroomApi = createMockApi()) {
  const reloadRoom = vi.fn();
  const view = renderWithBoardroom(
    () => <FollowUpWorkRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={reloadRoom} />,
    { api },
  );
  return { ...view, api, reloadRoom };
}

const posts = (api: MockBoardroomApi, path: string) => api.calls.filter((call) => call.method === "POST" && call.path === path);
const region = () => document.querySelector<HTMLElement>('[data-region="follow-up-work"]');

describe("follow-up work list", () => {
  it("lists tasks with status badge, link to the task page, relation, who, when and assignee", () => {
    const detail = detailFixture({
      workLinks: [
        linkView(),
        linkView({
          id: "link-2",
          issueId: "issue-2",
          relation: "linked",
          byUserId: "abcdef12-0000",
          issue: issueView({ id: "issue-2", identifier: "PAP-2", title: "Update docs", status: "done", assigneeAgentId: null, assigneeAgentName: null }),
        }),
      ],
    });
    renderRegion(detail);

    const items = within(screen.getByRole("list", { name: "Follow-up work" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId("status-badge")).toHaveTextContent("In progress");
    expect(within(items[0]!).getByRole("link", { name: "PAP-1 Raise prices" })).toHaveAttribute("href", "/C1/issues/PAP-1");
    expect(items[0]).toHaveTextContent("Created by You");
    expect(items[0]).toHaveTextContent("Assigned to Ada");
    expect(within(items[1]!).getByTestId("status-badge")).toHaveTextContent("Done");
    expect(within(items[1]!).getByTestId("status-badge")).toHaveAttribute("data-status", "ok");
    expect(items[1]).toHaveTextContent("Linked by Board user abcdef12");
    expect(items[1]).toHaveTextContent("Unassigned");
  });

  it("shows an empty message, and a row for a task that can no longer be read, which can still be unlinked", () => {
    const empty = renderRegion();
    expect(screen.getByText(/No follow-up work yet/)).toBeInTheDocument();
    empty.unmount();

    renderRegion(detailFixture({ workLinks: [linkView({ issueId: "11111111-2222", issue: null })] }));
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Task 11111111");
    expect(within(row).getByTestId("status-badge")).toHaveTextContent("Unavailable");
    expect(within(row).getByRole("button", { name: /^Unlink/ })).toBeInTheDocument();
  });

  it("is hidden for a viewer, and stays available in a closed Room for an operator", () => {
    const viewer = renderRegion(detailFixture({ permissions: { role: "viewer", canPost: false, canControl: false } }));
    expect(region()).toBeNull();
    expect(screen.queryByRole("button", { name: "Create follow-up work" })).not.toBeInTheDocument();
    viewer.unmount();

    renderRegion(detailFixture({ room: { status: "closed" }, permissions: { role: "operator", canPost: false, canControl: false } }));
    expect(screen.getByRole("button", { name: "Create follow-up work" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link existing task" })).toBeInTheDocument();
  });

  it("is missing from the Room page for a viewer and present for an owner", async () => {
    sdkUi.setLocation("/C1/boardroom/room-1");
    const viewerApi = createMockApi().on("GET", ROOM_PATH, detailFixture({ permissions: { role: "viewer", canPost: false, canControl: false } }));
    const viewer = renderWithBoardroom((context) => <BoardroomPage context={context} />, { api: viewerApi });
    await screen.findByRole("heading", { level: 1, name: "Raise prices?" });
    expect(region()).toBeNull();
    viewer.unmount();

    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api: createMockApi().on("GET", ROOM_PATH, detailFixture()) });
    await screen.findByRole("heading", { level: 1, name: "Raise prices?" });
    expect(region()).not.toBeNull();
  });
});

describe("create follow-up work", () => {
  function openCreate(detail = detailFixture({ room: { projectId: "project-7" } })) {
    sdkUi.state.projects = [
      { id: "project-7", name: "Growth" },
      { id: "project-8", name: "Ops" },
    ];
    const view = renderRegion(detail);
    fireEvent.click(screen.getByRole("button", { name: "Create follow-up work" }));
    return view;
  }

  it("defaults the project to the Room's, sends the plan, then reloads the Room and closes the form", async () => {
    const view = openCreate();
    const api = view.api.on("POST", WORK, { workLink: linkView(), issue: issueView(), planSaved: true } satisfies CreateWorkResponse);

    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("project-7");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Raise prices by 10 percent  " } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Roll out in Q1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), { target: { value: "agent:agent-1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Plan editor" }), { target: { value: "## Plan\n\n1. Announce" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(view.reloadRoom).toHaveBeenCalledTimes(1));
    expect(posts(api, WORK)).toHaveLength(1);
    expect(posts(api, WORK)[0]!.body).toEqual({
      title: "Raise prices by 10 percent",
      description: "Roll out in Q1",
      projectId: "project-7",
      assigneeAgentId: "agent-1",
      plan: "## Plan\n\n1. Announce",
      companyId: COMPANY_ID,
    });
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create follow-up work" })).toBeInTheDocument();
  });

  it("sends a user assignee, another project, and omits empty fields", async () => {
    const view = openCreate();
    const api = view.api.on("POST", WORK, { workLink: linkView(), issue: issueView(), planSaved: true });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Do it" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "project-8" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), { target: { value: "user:user-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(api, WORK)).toHaveLength(1));
    expect(posts(api, WORK)[0]!.body).toEqual({ title: "Do it", projectId: "project-8", assigneeUserId: "user-9", companyId: COMPANY_ID });
  });

  it("has no project when the Room has none and none is picked", async () => {
    const view = openCreate(detailFixture());
    const api = view.api.on("POST", WORK, { workLink: linkView(), issue: issueView(), planSaved: true });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Do it" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts(api, WORK)).toHaveLength(1));
    expect(posts(api, WORK)[0]!.body).toEqual({ title: "Do it", companyId: COMPANY_ID });
  });

  it("asks for a title and sends nothing without one", () => {
    const view = openCreate();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a title for the task.");
    expect(screen.getByLabelText("Title")).toHaveAttribute("aria-invalid", "true");
    expect(posts(view.api, WORK)).toHaveLength(0);
  });

  it("shows the host's message inline, keeps what was typed, and lets the user try again", async () => {
    const view = openCreate();
    let attempts = 0;
    view.api.on("POST", WORK, () => {
      attempts += 1;
      if (attempts === 1) throw new BoardroomApiError(422, { error: "issue_create_failed", message: "Project must belong to the same company" });
      return { workLink: linkView(), issue: issueView(), planSaved: true };
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Do it" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Plan editor" }), { target: { value: "My plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not create the task");
    expect(alert).toHaveTextContent("Project must belong to the same company");
    expect(screen.getByLabelText("Title")).toHaveValue("Do it");
    expect(screen.getByRole("textbox", { name: "Plan editor" })).toHaveValue("My plan");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(view.reloadRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(view.reloadRoom).toHaveBeenCalledTimes(1));
  });

  it("says when the task was created but its plan could not be saved", async () => {
    const view = openCreate();
    view.api.on("POST", WORK, { workLink: linkView(), issue: issueView(), planSaved: false, planError: "Document store is down" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Do it" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Plan editor" }), { target: { value: "Plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("The task PAP-1 was created, but its plan could not be saved: Document store is down");
    expect(view.reloadRoom).toHaveBeenCalled();
  });

  it("puts Cancel on the left and Create on the right of one footer row, and Cancel closes the form without a request", () => {
    const view = openCreate();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const create = screen.getByRole("button", { name: "Create" });
    expect(cancel.parentElement).toBe(create.parentElement);
    expect(cancel.parentElement).toHaveClass("br-footer");
    expect(cancel.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(cancel);
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    expect(view.api.calls).toEqual([]);
  });
});

describe("link and unlink", () => {
  it("searches, picks a task and links it by id, then reloads the Room", async () => {
    const api = createMockApi()
      .on("GET", `host:/companies/${COMPANY_ID}/issues`, [{ id: "issue-9", identifier: "PAP-9", title: "Pricing review" }])
      .on("POST", LINKS, linkView({ issueId: "issue-9", relation: "linked" }));
    const view = renderRegion(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Link existing task" }));

    expect(screen.getByRole("button", { name: "Link task" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Search tasks to link"), { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "PAP-9 Pricing review" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const link = screen.getByRole("button", { name: "Link task" });
    expect(cancel.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(link);

    await waitFor(() => expect(view.reloadRoom).toHaveBeenCalledTimes(1));
    expect(posts(api, LINKS)[0]!.body).toEqual({ issueId: "issue-9", companyId: COMPANY_ID });
    expect(screen.queryByLabelText("Search tasks to link")).not.toBeInTheDocument();
  });

  it("shows the server's message when the link is refused, and keeps the form open", async () => {
    const api = createMockApi()
      .on("GET", `host:/companies/${COMPANY_ID}/issues`, [{ id: "issue-9", identifier: "PAP-9", title: "Pricing review" }])
      .on("POST", LINKS, () => {
        throw new BoardroomApiError(409, { error: "already_linked", message: "That task is already linked to this Room" });
      });
    const view = renderRegion(detailFixture(), api);
    fireEvent.click(screen.getByRole("button", { name: "Link existing task" }));
    fireEvent.change(screen.getByLabelText("Search tasks to link"), { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "PAP-9 Pricing review" }));
    fireEvent.click(screen.getByRole("button", { name: "Link task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That task is already linked to this Room");
    expect(screen.getByRole("button", { name: "Link task" })).toBeEnabled();
    expect(view.reloadRoom).not.toHaveBeenCalled();
  });

  it("unlinks a row with DELETE on that task and reloads the Room", async () => {
    const api = createMockApi().on("DELETE", `${LINKS}/issue-1`, { removed: true, issueId: "issue-1" });
    const view = renderRegion(detailFixture({ workLinks: [linkView()] }), api);
    fireEvent.click(screen.getByRole("button", { name: "Unlink PAP-1 Raise prices" }));
    await waitFor(() => expect(view.reloadRoom).toHaveBeenCalledTimes(1));
    expect(api.calls).toEqual([{ method: "DELETE", path: `${LINKS}/issue-1`, query: { companyId: COMPANY_ID }, body: undefined }]);
  });

  it("reloads the Room when the link is already gone (404), so the stale row disappears", async () => {
    const api = createMockApi().on("DELETE", `${LINKS}/issue-1`, () => {
      throw new BoardroomApiError(404, { error: "work_link_not_found", message: "That task is not linked to this Room" });
    });
    const view = renderRegion(detailFixture({ workLinks: [linkView()] }), api);
    fireEvent.click(screen.getByRole("button", { name: "Unlink PAP-1 Raise prices" }));
    await waitFor(() => expect(view.reloadRoom).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an unlink failure on its own row and keeps the row", async () => {
    const api = createMockApi().on("DELETE", `${LINKS}/issue-1`, () => {
      throw new BoardroomApiError(500, { error: "internal_error", message: "That task is not linked to this Room" });
    });
    const view = renderRegion(detailFixture({ workLinks: [linkView(), linkView({ id: "link-2", issueId: "issue-2", issue: issueView({ id: "issue-2", identifier: "PAP-2", title: "Other" }) })] }), api);
    fireEvent.click(screen.getByRole("button", { name: "Unlink PAP-1 Raise prices" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That task is not linked to this Room");
    expect(screen.getAllByRole("listitem")[0]).toContainElement(alert);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(view.reloadRoom).not.toHaveBeenCalled();
  });
});
