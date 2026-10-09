import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage } from "../../src/ui/index.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { agentFixture, COMPANY_ID, detailFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const AGENTS = ["Ada", "Bea", "Cy", "Dan", "Eve", "Fay", "Gus", "Hal", "Ivy"].map((name) => agentFixture(name));
const AGENTS_PATH = `host:/companies/${COMPANY_ID}/agents`;

function renderCreate(api: MockBoardroomApi = createMockApi(), agents = AGENTS) {
  sdkUi.setLocation("/C1/boardroom/new");
  api.on("GET", AGENTS_PATH, agents);
  return { ...renderWithBoardroom((context) => <BoardroomPage context={context} />, { api }), api };
}

const agentBox = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });
const createCalls = (api: MockBoardroomApi) => api.calls.filter((call) => call.method === "POST" && call.path === "/rooms");

async function fillBasics() {
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "  Raise prices?  " } });
  fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Should we raise prices by 10 percent?" } });
}

describe("Create Room flow", () => {
  it("loads the company's agents and renders the form with Cancel left of Create in one footer row", async () => {
    renderCreate();

    expect(await screen.findByRole("heading", { name: "New Room" })).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByLabelText("Turn cap")).toHaveValue(40);

    const cancel = screen.getByRole("link", { name: "Cancel" });
    const create = screen.getByRole("button", { name: "Create Room" });
    expect(cancel.parentElement).toBe(create.parentElement);
    expect(cancel.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel).toHaveAttribute("href", "/C1/boardroom");
  });

  it("does not offer terminated agents", async () => {
    renderCreate(createMockApi(), [agentFixture("Ada"), agentFixture("Zed", { status: "terminated" })]);
    await screen.findByRole("checkbox", { name: /^Ada/ });
    expect(screen.queryByRole("checkbox", { name: /^Zed/ })).not.toBeInTheDocument();
  });

  it("sends the chosen title, topic, agents in pick order, project, linked task and cap, then opens the new Room", async () => {
    const api = createMockApi().on("GET", "host:/companies/company-1/issues", [
      { id: "issue-9", identifier: "PAP-9", title: "Pricing review" },
      { id: "issue-10", identifier: "PAP-10", title: "Pricing page" },
    ]);
    api.on("POST", "/rooms", () => detailFixture({ room: { id: "new-room" } }));
    sdkUi.state.projects = [{ id: "project-7", name: "Growth" }];
    renderCreate(api);

    await fillBasics();
    // Picked out of list order: Cy, then Ada, then Eve.
    fireEvent.click(agentBox("Cy"));
    fireEvent.click(agentBox("Ada"));
    fireEvent.click(agentBox("Eve"));
    expect(within(screen.getByRole("list", { name: "Picked agents in order" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "1. Cy×",
      "2. Ada×",
      "3. Eve×",
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "No project" }), { target: { value: "project-7" } });

    fireEvent.change(screen.getByLabelText("Search tasks to link"), { target: { value: "pricing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "PAP-9 Pricing review" }));
    expect(screen.getByText("PAP-9 Pricing review")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Turn cap"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));

    await waitFor(() => expect(sdkUi.navigations).toEqual(["/C1/boardroom/new-room"]));
    expect(createCalls(api)).toHaveLength(1);
    expect(createCalls(api)[0]!.body).toEqual({
      companyId: COMPANY_ID,
      title: "Raise prices?",
      topic: "Should we raise prices by 10 percent?",
      agentIds: ["agent-cy", "agent-ada", "agent-eve"],
      projectId: "project-7",
      linkedIssueId: "issue-9",
      maxTotalTurns: 25,
    });
    expect(api.calls.find((call) => call.path === "host:/companies/company-1/issues")!.query).toEqual({ q: "pricing", limit: "10" });
  });

  it("sends null for the optional fields left empty, and null for an empty cap (server default)", async () => {
    const api = createMockApi().on("POST", "/rooms", () => detailFixture({ room: { id: "r-new" } }));
    renderCreate(api);

    await fillBasics();
    fireEvent.click(agentBox("Ada"));
    fireEvent.change(screen.getByLabelText("Turn cap"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));

    await waitFor(() => expect(createCalls(api)).toHaveLength(1));
    expect(createCalls(api)[0]!.body).toMatchObject({ projectId: null, linkedIssueId: null, maxTotalTurns: null });
  });

  it("blocks a ninth agent in the picker and says why", async () => {
    renderCreate();
    await screen.findByRole("group", { name: "Agents" });

    for (const agent of AGENTS.slice(0, 8)) fireEvent.click(agentBox(agent.name));
    expect(screen.getByText(/8 of 8 selected\. A Room holds at most 8 agents\. Remove one to pick another\./)).toBeInTheDocument();

    fireEvent.click(agentBox("Ivy"));
    expect(agentBox("Ivy")).not.toBeChecked();
    expect(screen.getByText(/8 of 8 selected/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Picked agents in order" })).getAllByRole("listitem")).toHaveLength(8);

    // Removing one frees a slot.
    fireEvent.click(screen.getByRole("button", { name: "Remove Hal" }));
    expect(screen.getByText(/7 of 8 selected\.$/)).toBeInTheDocument();
    fireEvent.click(agentBox("Ivy"));
    expect(agentBox("Ivy")).toBeChecked();
  });

  it("shows a 422 from the create route in the form and keeps every value", async () => {
    const api = createMockApi().on("POST", "/rooms", () => {
      throw new BoardroomApiError(422, { error: "turn_cap_out_of_range", message: "The turn cap must be a whole number from 1 to 200", details: { min: 1, max: 200 } });
    });
    sdkUi.state.projects = [{ id: "project-7", name: "Growth" }];
    renderCreate(api);

    await fillBasics();
    fireEvent.click(agentBox("Bea"));
    fireEvent.click(agentBox("Ada"));
    fireEvent.change(screen.getByRole("combobox", { name: "No project" }), { target: { value: "project-7" } });
    fireEvent.change(screen.getByLabelText("Turn cap"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Room was not created");
    expect(alert).toHaveTextContent("The turn cap must be a whole number from 1 to 200");
    expect(sdkUi.navigations).toEqual([]);

    expect(screen.getByLabelText("Title")).toHaveValue("  Raise prices?  ");
    expect(screen.getByLabelText("Topic")).toHaveValue("Should we raise prices by 10 percent?");
    expect(screen.getByLabelText("Turn cap")).toHaveValue(500);
    expect(agentBox("Bea")).toBeChecked();
    expect(agentBox("Ada")).toBeChecked();
    expect(screen.getByRole("combobox", { name: "No project" })).toHaveValue("project-7");
    // The button is usable again, so the user can fix the cap and retry.
    expect(screen.getByRole("button", { name: "Create Room" })).toBeEnabled();
  });

  it("shows a refusal from the host (not the plugin) too", async () => {
    const api = createMockApi().on("POST", "/rooms", () => {
      throw new BoardroomApiError(403, { error: "Forbidden" });
    });
    renderCreate(api);
    await fillBasics();
    fireEvent.click(agentBox("Ada"));
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
  });

  it("asks for the missing title, topic and agent before sending anything", async () => {
    const { api } = renderCreate();
    await screen.findByRole("group", { name: "Agents" });

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));

    expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
    expect(screen.getByText("Enter the topic of the discussion.")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one agent.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveAttribute("aria-invalid", "true");
    expect(createCalls(api)).toHaveLength(0);
  });

  it("does not send twice while a create is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const api = createMockApi().on("POST", "/rooms", () => new Promise((resolve) => (release = resolve)));
    renderCreate(api);
    await fillBasics();
    fireEvent.click(agentBox("Ada"));

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const busy = await screen.findByRole("button", { name: "Creating…" });
    expect(busy).toBeDisabled();
    fireEvent.submit(busy.closest("form")!);
    expect(createCalls(api)).toHaveLength(1);

    release(detailFixture({ room: { id: "r-new" } }));
    await waitFor(() => expect(sdkUi.navigations).toEqual(["/C1/boardroom/r-new"]));
  });

  it("shows an error when the agents cannot be loaded, and retries", async () => {
    const api = createMockApi();
    let fail = true;
    api.on("GET", AGENTS_PATH, () => {
      if (fail) throw new BoardroomApiError(500, { error: "Internal server error" });
      return AGENTS;
    });
    sdkUi.setLocation("/C1/boardroom/new");
    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the company's agents");
    expect(screen.queryByRole("group", { name: "Agents" })).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("group", { name: "Agents" })).toBeInTheDocument();
  });

  it("says so when the company has no agents", async () => {
    const api = createMockApi().on("GET", AGENTS_PATH, []);
    sdkUi.setLocation("/C1/boardroom/new");
    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
    expect(await screen.findByText(/no agents to invite yet/)).toBeInTheDocument();
  });

  it("shows task search failures and empty results, and Enter searches without submitting the form", async () => {
    const api = createMockApi();
    let mode: "fail" | "empty" = "fail";
    api.on("GET", "host:/companies/company-1/issues", () => {
      if (mode === "fail") throw new BoardroomApiError(500, { error: "Search is down" });
      return [];
    });
    renderCreate(api);
    await screen.findByRole("group", { name: "Agents" });

    const search = screen.getByLabelText("Search tasks to link");
    fireEvent.change(search, { target: { value: "x" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is down");

    mode = "empty";
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByText(/No tasks match/)).toBeInTheDocument();
    expect(createCalls(api)).toHaveLength(0);
    expect(screen.queryByText("Enter a title.")).not.toBeInTheDocument();
  });

  it("lets the user remove a picked linked task", async () => {
    const api = createMockApi().on("GET", "host:/companies/company-1/issues", [{ id: "i1", identifier: null, title: "Untitled work" }]);
    renderCreate(api);
    await screen.findByRole("group", { name: "Agents" });
    fireEvent.change(screen.getByLabelText("Search tasks to link"), { target: { value: "u" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Untitled work" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove linked task" }));
    expect(screen.getByLabelText("Search tasks to link")).toBeInTheDocument();
  });

  it("goes back to the list on Cancel", async () => {
    renderCreate();
    fireEvent.click(await screen.findByRole("link", { name: "Cancel" }));
    expect(sdkUi.navigations).toEqual(["/C1/boardroom"]);
  });
});
