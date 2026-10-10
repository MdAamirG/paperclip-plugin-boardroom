import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RoundControlResponse, StopRoundResponse } from "../../src/api/types.js";
import { BoardroomApiError, BoardroomApiProvider } from "../../src/ui/api.js";
import { RoundProgressRegion } from "../../src/ui/regions/round-progress.js";
import { COMPANY_ID, detailFixture, roundFixture, turnFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, type MockBoardroomApi } from "../support/ui.js";

const BASE = "/rooms/room-1/rounds/r1";
const ROUNDS = "/rooms/room-1/rounds";
const RUN_CANCEL = "host:/heartbeat-runs/run-1/cancel";

const running = () =>
  roundFixture({
    turns: [
      turnFixture({ id: "t1", agentName: "Ada", status: "running", runId: "run-1" }),
      turnFixture({ id: "t2", agentId: "agent-2", agentName: "Grace", ord: 2 }),
    ],
  });

function renderRound(options: { round?: ReturnType<typeof roundFixture> | null; canControl?: boolean; api?: MockBoardroomApi; reloads?: { n: number } } = {}) {
  const api = options.api ?? createMockApi().on("GET", ROUNDS, { rounds: [] });
  const base = detailFixture();
  const detail = detailFixture({
    activeRound: options.round === undefined ? running() : options.round,
    permissions: { ...base.permissions, canControl: options.canControl ?? true },
  });
  const reloads = options.reloads ?? { n: 0 };
  renderWithBoardroom(() => <RoundProgressRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={() => (reloads.n += 1)} />, { api });
  return { api, reloads };
}

const button = (name: string) => screen.queryByRole("button", { name });
const posts = (api: MockBoardroomApi) => api.calls.filter((c) => c.method === "POST").map((c) => c.path);
const stopResponse = (extra: Partial<StopRoundResponse>): StopRoundResponse => ({ round: roundFixture({ status: "stopped" }), cancel: "none", ...extra });

describe("Round controls: visibility", () => {
  it("shows Pause and Stop on a running Round, Resume and Stop on a paused one", () => {
    const first = renderRound();
    expect(button("Pause")).toBeInTheDocument();
    expect(button("Resume")).not.toBeInTheDocument();
    expect(button("Stop")).toBeInTheDocument();
    first.api.calls.length = 0;
  });

  it("shows Resume, not Pause, on a paused Round, and says it is paused", () => {
    renderRound({ round: roundFixture({ ...running(), status: "paused" }) });
    expect(button("Resume")).toBeInTheDocument();
    expect(button("Pause")).not.toBeInTheDocument();
    expect(button("Stop")).toBeInTheDocument();
    expect(screen.getByText(/paused: no new Turn starts until you resume/)).toBeInTheDocument();
  });

  it("shows no controls without control", () => {
    renderRound({ canControl: false });
    for (const name of ["Pause", "Resume", "Stop"]) expect(button(name)).not.toBeInTheDocument();
  });

  it("shows no controls when there is no active Round", async () => {
    renderRound({ round: null });
    expect(await screen.findByText("No Round is running.")).toBeInTheDocument();
    for (const name of ["Pause", "Resume", "Stop"]) expect(button(name)).not.toBeInTheDocument();
  });
});

describe("Round controls: actions", () => {
  it("pauses and refreshes the Room", async () => {
    const api = createMockApi().on("POST", `${BASE}/pause`, { round: roundFixture({ status: "paused" }) } satisfies RoundControlResponse);
    const { reloads } = renderRound({ api });
    fireEvent.click(button("Pause")!);
    await waitFor(() => expect(reloads.n).toBe(1));
    expect(api.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pause`, body: { companyId: COMPANY_ID } });
  });

  it("resumes and refreshes the Room", async () => {
    const api = createMockApi().on("POST", `${BASE}/resume`, { round: roundFixture() } satisfies RoundControlResponse);
    const { reloads } = renderRound({ api, round: roundFixture({ ...running(), status: "paused" }) });
    fireEvent.click(button("Resume")!);
    await waitFor(() => expect(reloads.n).toBe(1));
    expect(posts(api)).toEqual([`${BASE}/resume`]);
  });

  it("shows the server's refusal and refreshes when the Round was no longer running", async () => {
    const api = createMockApi().on("POST", `${BASE}/pause`, () => {
      throw new BoardroomApiError(409, { error: "round_not_running", message: "This Round cannot be paused: it is completed" });
    });
    const { reloads } = renderRound({ api });
    fireEvent.click(button("Pause")!);
    expect(await screen.findByText("This Round cannot be paused: it is completed")).toBeInTheDocument();
    expect(screen.getByText("Could not pause the Round")).toBeInTheDocument();
    expect(reloads.n).toBe(1);
  });
});

describe("Round controls: Stop", () => {
  it("asks for confirmation and sends nothing until confirmed; Cancel is left, Stop right", async () => {
    const api = createMockApi().on("POST", `${BASE}/stop`, stopResponse({ cancel: "host" }));
    renderRound({ api });
    fireEvent.click(button("Stop")!);
    const dialog = screen.getByRole("alertdialog", { name: "Stop this Round?" });
    const buttons = Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Cancel", "Stop Round"]);
    expect(posts(api)).toEqual([]);
    fireEvent.click(button("Cancel")!);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(posts(api)).toEqual([]);
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    await waitFor(() => expect(posts(api)).toEqual([`${BASE}/stop`]));
  });

  it("does not call the board cancel route when the host cancelled the run", async () => {
    const api = createMockApi().on("POST", `${BASE}/stop`, stopResponse({ cancel: "host" }));
    const { reloads } = renderRound({ api });
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    await waitFor(() => expect(reloads.n).toBe(1));
    expect(posts(api)).toEqual([`${BASE}/stop`]);
  });

  it("cancels the run through the board route when the response is fallback", async () => {
    const api = createMockApi().on("POST", `${BASE}/stop`, stopResponse({ cancel: "fallback", fallbackRunId: "run-1" })).on("POST", RUN_CANCEL, {});
    const { reloads } = renderRound({ api });
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    await waitFor(() => expect(reloads.n).toBe(1));
    expect(posts(api)).toEqual([`${BASE}/stop`, RUN_CANCEL]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the Round is stopped but the run may still be running when the board cancel fails", async () => {
    const api = createMockApi()
      .on("POST", `${BASE}/stop`, stopResponse({ cancel: "fallback", fallbackRunId: "run-1" }))
      .on("POST", RUN_CANCEL, () => {
        throw new BoardroomApiError(403, { error: "Forbidden" });
      });
    const { reloads } = renderRound({ api });
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Round is stopped, but its run may still be running");
    expect(alert).toHaveTextContent("Forbidden");
    expect(reloads.n).toBe(1);
  });

  it("warns the same way when the host cancel failed", async () => {
    const api = createMockApi().on("POST", `${BASE}/stop`, stopResponse({ cancel: "failed" }));
    renderRound({ api });
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Round is stopped, but its run may still be running");
  });
});

describe("Round controls: Stop while the run is still starting (no host cancel)", () => {
  /** Turn 1 is running but its send has not returned: no run id yet. */
  const starting = (turn: Partial<ReturnType<typeof turnFixture>> = {}) =>
    roundFixture({ status: "stopped", turns: [turnFixture({ id: "t1", agentName: "Ada", status: "running", runId: null, ...turn })] });

  /** Render with a changeable `refreshKey` (the Room's live updates). */
  function renderStarting(api: MockBoardroomApi) {
    const detail = detailFixture({ activeRound: roundFixture({ turns: [turnFixture({ id: "t1", agentName: "Ada", status: "running", runId: null })] }) });
    const region = (refreshKey: number) => <RoundProgressRegion companyId={COMPANY_ID} detail={detail} refreshKey={refreshKey} reloadRoom={() => undefined} />;
    const result = renderWithBoardroom(() => region(0), { api });
    // The same tree `renderWithBoardroom` renders, so the region keeps its state.
    return { roomChanged: (refreshKey: number) => result.rerender(<BoardroomApiProvider api={api}>{region(refreshKey)}</BoardroomApiProvider>) };
  }

  function stopApi(rounds: { current: ReturnType<typeof roundFixture> }, cancel: () => unknown = () => ({})) {
    return createMockApi()
      .on("POST", `${BASE}/stop`, stopResponse({ cancel: "fallback", round: starting() }))
      .on("GET", ROUNDS, () => ({ rounds: [rounds.current] }))
      .on("POST", RUN_CANCEL, cancel);
  }

  async function pressStop() {
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    return screen.findByText(/cancelled from this page as soon as it starts/);
  }

  it("cancels the run through the board route once the Turn has its run id", async () => {
    const rounds = { current: starting() };
    const api = stopApi(rounds);
    const { roomChanged } = renderStarting(api);
    await pressStop();
    expect(posts(api)).toEqual([`${BASE}/stop`]);

    rounds.current = starting({ runId: "run-1" });
    roomChanged(1);
    await waitFor(() => expect(posts(api)).toEqual([`${BASE}/stop`, RUN_CANCEL]));
    await waitFor(() => expect(screen.queryByText(/cancelled from this page as soon as it starts/)).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the run may still be running when that cancel fails", async () => {
    const rounds = { current: starting({ runId: "run-1" }) };
    const api = stopApi(rounds, () => {
      throw new BoardroomApiError(403, { error: "Forbidden" });
    });
    renderStarting(api);
    fireEvent.click(button("Stop")!);
    fireEvent.click(button("Stop Round")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Round is stopped, but its run may still be running");
    expect(alert).toHaveTextContent("Forbidden");
    expect(posts(api)).toEqual([`${BASE}/stop`, RUN_CANCEL]);
  });

  it("stops waiting without a cancel when the Turn settled without a run", async () => {
    const rounds = { current: starting() };
    const api = stopApi(rounds);
    const { roomChanged } = renderStarting(api);
    await pressStop();
    rounds.current = starting({ status: "finished", outcome: "skipped", skipReason: "stopped" });
    roomChanged(1);
    await waitFor(() => expect(screen.queryByText(/cancelled from this page as soon as it starts/)).not.toBeInTheDocument());
    expect(posts(api)).toEqual([`${BASE}/stop`]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when the run ended before the page could cancel it, so its reply was kept", async () => {
    const rounds = { current: starting() };
    const api = stopApi(rounds);
    const { roomChanged } = renderStarting(api);
    await pressStop();
    rounds.current = starting({ runId: "run-1", status: "finished", outcome: "posted", messageId: "m2" });
    roomChanged(1);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The Round is stopped, but its run was not cancelled");
    expect(posts(api)).toEqual([`${BASE}/stop`]);
  });

  it("does not warn when the run ended as failed (it was cancelled)", async () => {
    const rounds = { current: starting() };
    const api = stopApi(rounds);
    const { roomChanged } = renderStarting(api);
    await pressStop();
    rounds.current = starting({ runId: "run-1", status: "finished", outcome: "failed" });
    roomChanged(1);
    await waitFor(() => expect(screen.queryByText(/cancelled from this page as soon as it starts/)).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Round progress: stopped state", () => {
  it("shows a stopped Round with its Turns marked stopped when no Round is active", async () => {
    const stopped = roundFixture({
      status: "stopped",
      seq: 2,
      turns: [
        turnFixture({ id: "t1", agentName: "Ada", status: "finished", outcome: "failed" }),
        turnFixture({ id: "t2", agentId: "agent-2", agentName: "Grace", ord: 2, status: "finished", outcome: "skipped", skipReason: "stopped" }),
      ],
    });
    const api = createMockApi().on("GET", ROUNDS, { rounds: [stopped] });
    renderRound({ round: null, api });
    expect(await screen.findByText("Round 2 was stopped.")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(button("Stop")).not.toBeInTheDocument();
  });

  it("does not show a completed Round as stopped", async () => {
    const api = createMockApi().on("GET", ROUNDS, { rounds: [roundFixture({ status: "completed" })] });
    renderRound({ round: null, api });
    expect(await screen.findByText("No Round is running.")).toBeInTheDocument();
  });
});
