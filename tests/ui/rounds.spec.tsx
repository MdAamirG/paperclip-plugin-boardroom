import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SendMessageResponse } from "../../src/api/types.js";
import { BoardroomApiError } from "../../src/ui/api.js";
import { ComposerRegion } from "../../src/ui/regions/composer.js";
import { RoundProgressRegion } from "../../src/ui/regions/round-progress.js";
import { TranscriptRegion } from "../../src/ui/regions/transcript.js";
import { COMPANY_ID, detailFixture, messageFixture, roundFixture, turnFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, type MockBoardroomApi } from "../support/ui.js";

const MESSAGES = "/rooms/room-1/messages";
const ROUNDS = "/rooms/room-1/rounds";

describe("Round progress", () => {
  const renderProgress = (detail = detailFixture()) =>
    renderWithBoardroom(() => <RoundProgressRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={() => {}} />);

  it("says no Round is running when there is none", () => {
    renderProgress();
    expect(screen.getByText("No Round is running.")).toBeInTheDocument();
  });

  it("lists the active Round's Turns in order with queued, running and finished states", () => {
    const round = roundFixture({
      seq: 3,
      turns: [
        turnFixture({ id: "t1", agentId: "a1", agentName: "Ada", ord: 1, status: "finished", outcome: "posted" }),
        turnFixture({ id: "t2", agentId: "a2", agentName: "Grace", ord: 2, status: "finished", outcome: "silent" }),
        turnFixture({ id: "t3", agentId: "a3", agentName: "Linus", ord: 3, status: "finished", outcome: "failed", hostMessage: "adapter crashed" }),
        turnFixture({ id: "t4", agentId: "a4", agentName: "Ken", ord: 4, status: "running" }),
        turnFixture({ id: "t5", agentId: "a5", agentName: null, ord: 5, status: "queued" }),
      ],
    });
    renderProgress(detailFixture({ activeRound: round }));
    expect(screen.getByText("Round 3")).toBeInTheDocument();
    expect(screen.getByText("(3 of 5 turns done)")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Ada Replied $0.00",
      "Grace Stayed silent $0.00",
      "Linus Failed adapter crashed $0.00",
      "Ken Answering…",
      "Removed agent (a5) Waiting",
    ]);
    expect(rows[3]).toHaveAttribute("data-turn-status", "running");
    expect(rows[4]).toHaveAttribute("data-turn-status", "queued");
  });
});

describe("Transcript: Turn outcome markers", () => {
  function renderTranscript(api: MockBoardroomApi) {
    return renderWithBoardroom(() => <TranscriptRegion companyId={COMPANY_ID} detail={detailFixture()} refreshKey={0} reloadRoom={() => {}} />, { api });
  }

  it("shows silent and failed Turns inline at the time they ended, and nothing extra for a posted Turn", async () => {
    const api = createMockApi()
      .on("GET", MESSAGES, {
        messages: [
          messageFixture({ id: "m1", body: "Question", createdAt: "2026-10-01T09:00:00.000Z" }),
          messageFixture({ id: "m2", authorKind: "agent", authorId: "agent-1", authorName: "Ada", body: "My view", roundId: "r1", turnId: "t1", createdAt: "2026-10-01T09:01:00.000Z" }),
          messageFixture({ id: "m3", body: "Thanks", createdAt: "2026-10-01T09:05:00.000Z" }),
        ],
        hasMore: false,
      })
      .on("GET", ROUNDS, {
        rounds: [
          roundFixture({
            status: "completed",
            turns: [
              turnFixture({ id: "t1", agentId: "agent-1", agentName: "Ada", status: "finished", outcome: "posted", finishedAt: "2026-10-01T09:01:00.000Z" }),
              turnFixture({ id: "t2", agentId: "agent-2", agentName: "Grace", ord: 2, status: "finished", outcome: "silent", finishedAt: "2026-10-01T09:02:00.000Z" }),
              turnFixture({ id: "t3", agentId: "agent-3", agentName: "Linus", ord: 3, status: "finished", outcome: "failed", hostMessage: "adapter crashed", finishedAt: "2026-10-01T09:03:00.000Z" }),
            ],
          }),
        ],
      });
    renderTranscript(api);
    const log = await screen.findByRole("log", { name: "Transcript" });
    await waitFor(() => expect(within(log).getAllByRole("status")).toHaveLength(2));
    const order = Array.from(log.children).map((el) => el.getAttribute("data-message-id") ?? `marker:${el.getAttribute("data-turn-outcome")}`);
    expect(order).toEqual(["m1", "m2", "marker:silent", "marker:failed", "m3"]);
    const [silent, failed] = within(log).getAllByRole("status");
    expect(silent).toHaveTextContent("Grace stayed silent");
    expect(failed).toHaveTextContent("Linus could not answer");
    expect(failed).toHaveTextContent("adapter crashed");
    expect(within(log).getAllByRole("article")[1]).toHaveTextContent("Ada");
  });

  it("shows no marker for a Turn that ended before the oldest loaded Message", async () => {
    const api = createMockApi()
      .on("GET", MESSAGES, { messages: [messageFixture({ id: "m9", createdAt: "2026-10-01T10:00:00.000Z" })], hasMore: true })
      .on("GET", ROUNDS, { rounds: [roundFixture({ turns: [turnFixture({ status: "finished", outcome: "silent", finishedAt: "2026-10-01T09:00:00.000Z" })] })] });
    renderTranscript(api);
    await screen.findByRole("log", { name: "Transcript" });
    await waitFor(() => expect(api.calls.some((c) => c.path === ROUNDS)).toBe(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a failed Turn marker load and keeps the Messages", async () => {
    const api = createMockApi()
      .on("GET", MESSAGES, { messages: [messageFixture({ id: "m1", body: "Still here" })], hasMore: false })
      .on("GET", ROUNDS, () => {
        throw new BoardroomApiError(500, { error: "internal_error", message: "boom" });
      });
    renderTranscript(api);
    expect(await screen.findByText("Still here")).toBeInTheDocument();
    expect(await screen.findByText("Could not load the Turn markers")).toBeInTheDocument();
  });
});

describe("Composer: Round hints", () => {
  const sent = (): SendMessageResponse => ({ message: messageFixture({ id: "new" }), round: roundFixture(), ignoredMentions: [] });
  const box = () => screen.getByRole("textbox", { name: /Message/ }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

  function renderComposer(api: MockBoardroomApi, detail = detailFixture(), reloadRoom = () => {}) {
    return renderWithBoardroom(() => <ComposerRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={reloadRoom} />, { api });
  }

  function mention(name: string) {
    type("@");
    fireEvent.mouseDown(screen.getByRole("option", { name: new RegExp(name) }));
  }

  it("tells a user with control that a mention starts a Round, and names who will reply", () => {
    renderComposer(createMockApi());
    expect(screen.getByText(/starts a Round/)).toBeInTheDocument();
    mention("Ada");
    expect(screen.getByText(/Sending will start a Round: Ada will reply/)).toBeInTheDocument();
  });

  it("sends the mention and refreshes the Room when a Round starts", async () => {
    const api = createMockApi().on("POST", MESSAGES, sent());
    let reloaded = 0;
    renderComposer(api, detailFixture(), () => (reloaded += 1));
    mention("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(reloaded).toBe(1));
    expect(api.calls.find((c) => c.method === "POST")?.body).toMatchObject({ mentions: ["agent-1"] });
  });

  it("hides the Round-starting picker from a user without control", () => {
    renderComposer(createMockApi(), detailFixture({ permissions: { role: "operator", canPost: true, canControl: false } }));
    type("hello @");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/starts a Round/)).not.toBeInTheDocument();
    expect(box()).toHaveAttribute("placeholder", "Write a note.");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("blocks a send with mentions while a Round is running, and still allows a plain note", () => {
    renderComposer(createMockApi(), detailFixture({ activeRound: roundFixture() }));
    type("Plain note");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    mention("Ada");
    expect(screen.getByText(/A Round is already in progress/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the server's refusal (turn cap) and keeps the draft", async () => {
    const api = createMockApi().on("POST", MESSAGES, () => {
      throw new BoardroomApiError(422, { error: "turn_cap_reached", message: "This would pass the Room's limit of 1 Turns" });
    });
    renderComposer(api);
    mention("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/limit of 1 Turns/)).toBeInTheDocument();
    expect(box().value).toContain("@Ada");
  });
});

describe("Ask all and skipped Turns (ticket 07)", () => {
  const renderComposer = (detail = detailFixture(), api = createMockApi().on("POST", MESSAGES, { message: messageFixture(), round: null, ignoredMentions: [] } satisfies SendMessageResponse)) => {
    renderWithBoardroom(() => <ComposerRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={() => {}} />, { api });
    return api;
  };

  it("sends askAll: true when the Owner ticks Ask all participants", async () => {
    const api = renderComposer();
    fireEvent.click(screen.getByLabelText("Ask all participants"));
    fireEvent.change(screen.getByLabelText("Message (Markdown)"), { target: { value: "Everyone, thoughts?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(JSON.stringify(post)).toContain('"askAll":true');
  });

  it("hides Ask all for operators", () => {
    const base = detailFixture();
    renderComposer(detailFixture({ permissions: { ...base.permissions, canControl: false } }));
    expect(screen.queryByLabelText("Ask all participants")).not.toBeInTheDocument();
  });

  it("shows a skipped Turn's host message word for word in progress and in the transcript", async () => {
    const turn = turnFixture({ status: "finished", outcome: "skipped", skipReason: "not_invokable", hostMessage: "Agent is over budget", finishedAt: "2026-10-01T09:02:00.000Z" });
    renderWithBoardroom(() => <RoundProgressRegion companyId={COMPANY_ID} detail={detailFixture({ activeRound: roundFixture({ turns: [turn] }) })} refreshKey={0} reloadRoom={() => {}} />);
    expect(screen.getByText("Agent is over budget")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });

  it("shows the host message in the transcript marker", async () => {
    const turn = turnFixture({ status: "finished", outcome: "skipped", skipReason: "not_invokable", hostMessage: "Agent is over budget", finishedAt: "2026-10-01T09:02:00.000Z" });
    const api = createMockApi()
      .on("GET", MESSAGES, { messages: [messageFixture({ createdAt: "2026-10-01T09:00:00.000Z" })], hasMore: false })
      .on("GET", ROUNDS, { rounds: [roundFixture({ status: "completed", turns: [turn] })] });
    renderWithBoardroom(() => <TranscriptRegion companyId={COMPANY_ID} detail={detailFixture()} refreshKey={0} reloadRoom={() => {}} />, { api });
    expect(await screen.findByText("Agent is over budget")).toBeInTheDocument();
  });
});
