import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentCost, RoomCostsResponse, TurnCost } from "../../src/api/types.js";
import { BoardroomPage } from "../../src/ui/index.js";
import { capState, formatSpend, formatTokens } from "../../src/ui/cost-format.js";
import { CostStripRegion } from "../../src/ui/regions/cost-strip.js";
import { RoundProgressRegion } from "../../src/ui/regions/round-progress.js";
import { TranscriptRegion } from "../../src/ui/regions/transcript.js";
import { COMPANY_ID, detailFixture, messageFixture, roundFixture, turnFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const COSTS = "/rooms/room-1/costs";

function agentCost(overrides: Partial<AgentCost> = {}): AgentCost {
  return {
    agentId: "agent-1",
    agentName: "Ada",
    isActiveParticipant: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    outcomes: { posted: 0, silent: 0, failed: 0, skipped: 0 },
    subscriptionBilled: false,
    ...overrides,
  };
}

function costsFixture(overrides: Partial<RoomCostsResponse> = {}): RoomCostsResponse {
  return {
    roomId: "room-1",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    subscriptionBilled: false,
    turnsUsed: 0,
    maxTotalTurns: 40,
    agents: [],
    ...overrides,
  };
}

const turnCost = (overrides: Partial<TurnCost> = {}): TurnCost => ({
  costCents: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  events: 0,
  subscriptionBilled: false,
  ...overrides,
});

function renderStrip(api: MockBoardroomApi) {
  return renderWithBoardroom(() => <CostStripRegion companyId={COMPANY_ID} detail={detailFixture()} refreshKey={0} reloadRoom={() => {}} />, { api });
}

describe("cost helpers", () => {
  it("warns from 80% of the cap, and says the cap is reached at 100%", () => {
    expect(capState(31, 40)).toBe("ok");
    expect(capState(32, 40)).toBe("warning");
    expect(capState(39, 40)).toBe("warning");
    expect(capState(40, 40)).toBe("reached");
    expect(capState(41, 40)).toBe("reached");
    expect(capState(3, 5)).toBe("ok");
    expect(capState(4, 5)).toBe("warning");
  });

  it("formats dollars and subscription spend", () => {
    expect(formatSpend(125, false)).toBe("$1.25");
    expect(formatSpend(0, true)).toBe("$0 (subscription)");
    expect(formatSpend(5, true)).toBe("$0.05");
    expect(formatTokens({ inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80 })).toBe("1,200 in · 80 out");
    expect(formatTokens({ inputTokens: 1200, cachedInputTokens: 300, outputTokens: 80 })).toBe("1,200 in · 300 cached · 80 out");
  });
});

describe("Cost strip", () => {
  it("shows total spend, tokens, runs and Turns used", async () => {
    const api = createMockApi().on("GET", COSTS, costsFixture({ costCents: 1234, inputTokens: 5000, cachedInputTokens: 1000, outputTokens: 700, runCount: 3, turnsUsed: 5, maxTotalTurns: 40 }));
    renderStrip(api);
    const strip = await screen.findByTestId("cost-strip");
    expect(within(strip).getByText("$12.34")).toBeInTheDocument();
    expect(within(strip).getByText("5,000 in · 1,000 cached · 700 out")).toBeInTheDocument();
    expect(within(strip).getByText("3")).toBeInTheDocument();
    expect(within(strip).getByText("Turns used")).toBeInTheDocument();
    expect(within(strip).getByText("5 / 40")).toBeInTheDocument();
    expect(screen.queryByTestId("cap-notice")).not.toBeInTheDocument();
    expect(api.calls[0]).toMatchObject({ method: "GET", path: COSTS });
  });

  it("shows no warning at 31 of 40, a warning at 32 of 40, and the cap-reached state at 40 of 40", async () => {
    const at31 = createMockApi().on("GET", COSTS, costsFixture({ turnsUsed: 31 }));
    const first = renderStrip(at31);
    await screen.findByTestId("cost-strip");
    expect(screen.getByTestId("cost-strip")).toHaveAttribute("data-cap-state", "ok");
    expect(screen.queryByTestId("cap-notice")).not.toBeInTheDocument();
    first.unmount();

    const at32 = createMockApi().on("GET", COSTS, costsFixture({ turnsUsed: 32 }));
    const second = renderStrip(at32);
    expect(await screen.findByTestId("cap-notice")).toHaveTextContent("Warning: 80% or more of the turn cap is used");
    expect(screen.getByTestId("cost-strip")).toHaveAttribute("data-cap-state", "warning");
    second.unmount();

    const at40 = createMockApi().on("GET", COSTS, costsFixture({ turnsUsed: 40 }));
    renderStrip(at40);
    expect(await screen.findByTestId("cap-notice")).toHaveTextContent("Cap reached: a new Round needs a higher turn cap.");
    expect(screen.getByTestId("cost-strip")).toHaveAttribute("data-cap-state", "reached");
  });

  it("shows tokens with $0 (subscription) when billing is subscription only", async () => {
    const api = createMockApi().on(
      "GET",
      COSTS,
      costsFixture({
        inputTokens: 900,
        outputTokens: 100,
        runCount: 1,
        subscriptionBilled: true,
        agents: [agentCost({ inputTokens: 900, outputTokens: 100, runCount: 1, subscriptionBilled: true })],
      }),
    );
    renderStrip(api);
    const strip = await screen.findByTestId("cost-strip");
    expect(within(strip).getByText("$0 (subscription)")).toBeInTheDocument();
    expect(within(strip).getByText("900 in · 100 out")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Cost per agent" })).getByText("$0 (subscription)")).toBeInTheDocument();
  });

  it("lists every agent with spend, tokens and outcome counts, and marks removed Participants", async () => {
    const api = createMockApi().on(
      "GET",
      COSTS,
      costsFixture({
        agents: [
          agentCost({ agentId: "a1", agentName: "Ada", costCents: 250, inputTokens: 100, outputTokens: 50, outcomes: { posted: 2, silent: 1, failed: 0, skipped: 0 } }),
          agentCost({ agentId: "a2", agentName: "Grace", isActiveParticipant: false, costCents: 75, outcomes: { posted: 0, silent: 0, failed: 1, skipped: 1 } }),
          agentCost({ agentId: "a3deadbeef", agentName: null, isActiveParticipant: false }),
        ],
      }),
    );
    renderStrip(api);
    const table = await screen.findByRole("table", { name: "Cost per agent" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Ada");
    expect(rows[0]).not.toHaveTextContent("no longer in this Room");
    expect(rows[0]).toHaveTextContent("$2.50");
    expect(rows[0]).toHaveTextContent("100 in · 50 out");
    expect(rows[0]).toHaveTextContent("2 replied · 1 silent · 0 failed · 0 skipped");
    expect(rows[1]).toHaveTextContent("Grace (no longer in this Room)");
    expect(rows[1]).toHaveTextContent("$0.75");
    expect(rows[1]).toHaveTextContent("0 replied · 0 silent · 1 failed · 1 skipped");
    expect(rows[1]).toHaveAttribute("data-active-participant", "false");
    expect(rows[2]).toHaveTextContent("Removed agent (a3deadbe)");
  });

  it("says so when no Turn has run", async () => {
    renderStrip(createMockApi().on("GET", COSTS, costsFixture()));
    expect(await screen.findByText("No Turns have run in this Room yet.")).toBeInTheDocument();
  });

  it("reports a load failure with a retry", async () => {
    renderStrip(createMockApi());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the cost");
  });

  it("refetches when the Room changes", async () => {
    let spent = 100;
    const api = createMockApi()
      .on("GET", "/rooms/room-1", detailFixture())
      .on("GET", "/rooms/room-1/messages", { messages: [], hasMore: false })
      .on("GET", "/rooms/room-1/rounds", { rounds: [] })
      .on("GET", "host:/companies/company-1/agents", [])
      .on("GET", COSTS, () => costsFixture({ costCents: spent }));
    sdkUi.setLocation("/C1/boardroom/room-1");
    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
    const strip = await screen.findByTestId("cost-strip");
    expect(within(strip).getByText("$1.00")).toBeInTheDocument();

    spent = 250;
    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "room-1", companyId: COMPANY_ID }));
    await waitFor(() => expect(within(screen.getByTestId("cost-strip")).getByText("$2.50")).toBeInTheDocument());
    expect(api.calls.filter((call) => call.path === COSTS)).toHaveLength(2);
  });
});

describe("Per-Turn cost", () => {
  it("shows each Round-progress row's cost, and the skip reason instead for a skipped Turn", () => {
    const round = roundFixture({
      turns: [
        turnFixture({ id: "t1", agentName: "Ada", status: "finished", outcome: "posted", cost: turnCost({ costCents: 125, inputTokens: 1000, outputTokens: 200, events: 1 }) }),
        turnFixture({ id: "t2", agentId: "a2", agentName: "Grace", ord: 2, status: "finished", outcome: "silent", cost: turnCost({ costCents: 0, inputTokens: 40, outputTokens: 2, events: 1, subscriptionBilled: true }) }),
        turnFixture({ id: "t3", agentId: "a3", agentName: "Linus", ord: 3, status: "finished", outcome: "skipped", skipReason: "stopped" }),
        turnFixture({ id: "t4", agentId: "a4", agentName: "Ken", ord: 4, status: "finished", outcome: "skipped", skipReason: "not_invokable" }),
        turnFixture({ id: "t5", agentId: "a5", agentName: "Dennis", ord: 5, status: "queued" }),
      ],
    });
    renderWithBoardroom(() => <RoundProgressRegion companyId={COMPANY_ID} detail={detailFixture({ activeRound: round })} refreshKey={0} reloadRoom={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Ada Replied $1.25 · 1,000 in · 200 out");
    expect(rows[1]).toHaveTextContent("Grace Stayed silent $0 (subscription) · 40 in · 2 out");
    expect(rows[2]).toHaveTextContent("Linus Skipped the Round was stopped");
    expect(rows[2]).not.toHaveTextContent("$");
    expect(rows[3]).toHaveTextContent("Ken Skipped the agent cannot be woken");
    expect(rows[4]).toHaveTextContent("Dennis Waiting");
    expect(rows[4]).not.toHaveTextContent("$");
  });

  it("shows $0.00 for a finished Turn that has no cost events", () => {
    const round = roundFixture({ turns: [turnFixture({ status: "finished", outcome: "posted" })] });
    renderWithBoardroom(() => <RoundProgressRegion companyId={COMPANY_ID} detail={detailFixture({ activeRound: round })} refreshKey={0} reloadRoom={() => {}} />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Ada Replied $0.00");
  });

  it("shows cost on a Message's Turn and on silent and skipped Turn markers in the transcript", async () => {
    const api = createMockApi()
      .on("GET", "/rooms/room-1/messages", {
        messages: [
          messageFixture({ id: "m1", body: "Question", createdAt: "2026-10-01T09:00:00.000Z" }),
          messageFixture({ id: "m2", authorKind: "agent", authorId: "agent-1", authorName: "Ada", body: "My view", roundId: "r1", turnId: "t1", createdAt: "2026-10-01T09:01:00.000Z" }),
        ],
        hasMore: false,
      })
      .on("GET", "/rooms/room-1/rounds", {
        rounds: [
          roundFixture({
            status: "completed",
            turns: [
              turnFixture({ id: "t1", agentName: "Ada", status: "finished", outcome: "posted", finishedAt: "2026-10-01T09:01:00.000Z", cost: turnCost({ costCents: 40, inputTokens: 10, outputTokens: 5, events: 1 }) }),
              turnFixture({ id: "t2", agentId: "a2", agentName: "Grace", ord: 2, status: "finished", outcome: "silent", finishedAt: "2026-10-01T09:02:00.000Z", cost: turnCost({ costCents: 7, inputTokens: 3, outputTokens: 0, events: 1 }) }),
              turnFixture({ id: "t3", agentId: "a3", agentName: "Linus", ord: 3, status: "finished", outcome: "skipped", skipReason: "stopped", finishedAt: "2026-10-01T09:03:00.000Z" }),
            ],
          }),
        ],
      });
    renderWithBoardroom(() => <TranscriptRegion companyId={COMPANY_ID} detail={detailFixture()} refreshKey={0} reloadRoom={() => {}} />, { api });
    const log = await screen.findByRole("log", { name: "Transcript" });
    await waitFor(() => expect(within(log).getAllByRole("status")).toHaveLength(2));
    const message = log.querySelector('[data-message-id="m2"]')!;
    expect(message).toHaveTextContent("$0.40 · 10 in · 5 out");
    expect(log.querySelector('[data-turn-id="t2"]')).toHaveTextContent("Grace stayed silent$0.07 · 3 in · 0 out");
    const skipped = log.querySelector('[data-turn-id="t3"]')!;
    expect(skipped).toHaveTextContent("Linus was skippedthe Round was stopped");
    expect(skipped).not.toHaveTextContent("$");
  });
});
