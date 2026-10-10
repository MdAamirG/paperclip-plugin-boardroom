/**
 * F5: when the host's live stream is off (501) the page keeps itself fresh by polling the Room
 * (and with it the transcript, Rounds and cost regions), faster while a Round is active, and stops
 * while hidden. The notice stays as a small status, not a dead end.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardroomPage } from "../../src/ui/index.js";
import { POLL_ACTIVE_MS, POLL_IDLE_MS } from "../../src/ui/hooks.js";
import { COMPANY_ID, detailFixture, roundFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type MockBoardroomApi } from "../support/ui.js";

const ROOM_PATH = "/rooms/room-1";
const OFF = new Error("Plugin stream bridge is not enabled");

function renderRoom(api: MockBoardroomApi) {
  api.on("GET", "/rooms/room-1/messages", { messages: [], hasMore: false });
  api.on("GET", "/rooms/room-1/rounds", { rounds: [] });
  api.on("GET", "/rooms/room-1/costs", { roomId: "room-1", costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0, subscriptionBilled: false, turnsUsed: 0, maxTotalTurns: 40, agents: [] });
  api.on("GET", "host:/companies/company-1/agents", []);
  sdkUi.setLocation("/C1/boardroom/room-1");
  return renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
}

const calls = (api: MockBoardroomApi, path: string) => api.calls.filter((call) => call.method === "GET" && call.path === path).length;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("polling when the live stream is off", () => {
  it("does not poll while the stream works", async () => {
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture());
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });
    await advance(POLL_IDLE_MS * 3);
    expect(calls(api, ROOM_PATH)).toBe(1);
    expect(screen.queryByTestId("live-updates-notice")).not.toBeInTheDocument();
  });

  it("polls the Room, transcript and Rounds every 5 seconds while a Round is active", async () => {
    sdkUi.setStreamError("boardroom", OFF);
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ activeRound: roundFixture({ status: "running" }) }));
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(calls(api, "/rooms/room-1/rounds")).toBeGreaterThan(0));
    const room = calls(api, ROOM_PATH);
    const messages = calls(api, "/rooms/room-1/messages");
    const rounds = calls(api, "/rooms/room-1/rounds");

    await advance(POLL_ACTIVE_MS + 100);
    await waitFor(() => {
      expect(calls(api, ROOM_PATH)).toBeGreaterThan(room);
      expect(calls(api, "/rooms/room-1/messages")).toBeGreaterThan(messages);
      expect(calls(api, "/rooms/room-1/rounds")).toBeGreaterThan(rounds);
    });
  });

  it("polls slower when no Round is active", async () => {
    sdkUi.setStreamError("boardroom", OFF);
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ activeRound: null }));
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });
    const before = calls(api, ROOM_PATH);
    await advance(POLL_ACTIVE_MS * 2);
    expect(calls(api, ROOM_PATH)).toBe(before);
    await advance(POLL_IDLE_MS);
    expect(calls(api, ROOM_PATH)).toBeGreaterThan(before);
  });

  it("stops while the page is hidden and refetches once when it is shown again", async () => {
    sdkUi.setStreamError("boardroom", OFF);
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ activeRound: roundFixture({ status: "running" }) }));
    renderRoom(api);
    await screen.findByRole("heading", { level: 1 });

    setVisibility("hidden");
    const hidden = calls(api, ROOM_PATH);
    await advance(POLL_ACTIVE_MS * 4);
    expect(calls(api, ROOM_PATH)).toBe(hidden);

    setVisibility("visible");
    await advance(10);
    expect(calls(api, ROOM_PATH)).toBeGreaterThan(hidden);
  });

  it("shows a small honest notice that says the page refreshes itself, with no instruction to reload", async () => {
    sdkUi.setStreamError("boardroom", OFF);
    const api = createMockApi().on("GET", ROOM_PATH, detailFixture({ activeRound: roundFixture({ status: "running" }) }));
    renderRoom(api);
    const notice = await screen.findByTestId("live-updates-notice");
    expect(notice).toHaveTextContent("Live updates are off");
    expect(notice).toHaveTextContent("Plugin stream bridge is not enabled");
    // The notice first shows the idle interval until the running Round loads, then the active one.
    await waitFor(() => expect(notice).toHaveTextContent("refreshes itself and checks for changes every 5 seconds"));
    expect(notice).not.toHaveTextContent(/reload the page/i);
    expect(COMPANY_ID).toBeDefined();
  });
});
