import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BoardroomApiError, BoardroomApiProvider } from "../../src/ui/api.js";
import { TranscriptRegion } from "../../src/ui/regions/transcript.js";
import { announceMessagePosted } from "../../src/ui/regions/message-bus.js";
import { COMPANY_ID, detailFixture, messageFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, type ApiCall, type MockBoardroomApi } from "../support/ui.js";

const PATH = "/rooms/room-1/messages";
const msg = (n: number, overrides = {}) => messageFixture({ id: `m${n}`, body: `Body ${n}`, ...overrides });

function renderTranscript(api: MockBoardroomApi, props: { refreshKey?: number; detail?: ReturnType<typeof detailFixture> } = {}) {
  const build = (refreshKey: number) => (
    <TranscriptRegion companyId={COMPANY_ID} detail={props.detail ?? detailFixture()} refreshKey={refreshKey} reloadRoom={() => {}} />
  );
  const result = renderWithBoardroom(() => build(props.refreshKey ?? 0), { api });
  return { ...result, setRefreshKey: (key: number) => result.rerender(<BoardroomApiProvider api={api}>{build(key)}</BoardroomApiProvider>) };
}

const messagesCalls = (api: MockBoardroomApi) => api.calls.filter((c) => c.path === PATH);
const log = () => screen.getByRole("log", { name: "Transcript" });

let scrollHeight = 0;
let clientHeight = 0;
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

function fakeLayout(height: number, client = 100) {
  scrollHeight = height;
  clientHeight = client;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
}

afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
  else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe("Transcript region", () => {
  it("shows a loading state, then the Messages oldest first with author labels and Markdown bodies", async () => {
    let release: (value: unknown) => void = () => {};
    const api = createMockApi().on("GET", PATH, () => new Promise((resolve) => (release = resolve)));
    renderTranscript(api);
    expect(screen.getByText("Loading the transcript…")).toBeInTheDocument();

    release({
      messages: [
        msg(1, { authorId: "user-owner-1", body: "**Mine**" }),
        msg(2, { authorId: "abcdef12-0000-0000-0000-000000000000", body: "From someone" }),
        msg(3, { authorId: "local-board" }),
        msg(4, { authorKind: "agent", authorId: "agent-1", authorName: "Ada", body: "Raise it 5%", roundId: "r1", turnId: "t1", runId: "run1" }),
        msg(5, { authorKind: "agent", authorId: "agent-gone", authorName: null }),
      ],
      hasMore: false,
    });
    const articles = await screen.findAllByRole("article");
    expect(articles).toHaveLength(5);
    expect(within(articles[0]!).getByText("You")).toBeInTheDocument();
    expect(within(articles[0]!).getByTestId("markdown-block")).toHaveTextContent("**Mine**");
    expect(within(articles[1]!).getByText("Board user abcdef12")).toBeInTheDocument();
    expect(within(articles[2]!).getByText("Board")).toBeInTheDocument();
    expect(within(articles[3]!).getByText("Ada")).toBeInTheDocument();
    expect(within(articles[3]!).getByText("agent")).toBeInTheDocument();
    expect(within(articles[4]!).getByText("Removed agent (agent-go)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load earlier/ })).not.toBeInTheDocument();
    expect(messagesCalls(api)[0]).toMatchObject({ method: "GET", query: { limit: "50", companyId: COMPANY_ID } });
  });

  it("marks an agent that is no longer a Participant but keeps its name", async () => {
    const api = createMockApi().on("GET", PATH, {
      messages: [msg(1, { authorKind: "agent", authorId: "agent-1", authorName: "Ada" }), msg(2, { authorKind: "agent", authorId: "agent-9", authorName: "Linus" })],
      hasMore: false,
    });
    renderTranscript(api);
    const articles = await screen.findAllByRole("article");
    expect(within(articles[0]!).getByText("agent")).toBeInTheDocument();
    expect(within(articles[1]!).getByText("Linus")).toBeInTheDocument();
    expect(within(articles[1]!).getByText("agent · no longer in this Room")).toBeInTheDocument();
  });

  it("says so when there are no Messages", async () => {
    renderTranscript(createMockApi().on("GET", PATH, { messages: [], hasMore: false }));
    expect(await screen.findByText("No messages yet.")).toBeInTheDocument();
  });

  it("loads earlier Messages above the current ones, without duplicates", async () => {
    const api = createMockApi().on("GET", PATH, (call: ApiCall) => {
      // The older page overlaps the newer one by one Message (m3); it must show once.
      if (call.query?.before === "m3") return { messages: [msg(1), msg(2), msg(3)], hasMore: false };
      return { messages: [msg(3), msg(4), msg(5)], hasMore: true };
    });
    renderTranscript(api);
    await screen.findAllByRole("article");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(5));
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("data-message-id"))).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(messagesCalls(api).at(-1)).toMatchObject({ query: { before: "m3", limit: "50" } });
    expect(screen.queryByRole("button", { name: /Load earlier/ })).not.toBeInTheDocument();
  });

  it("pages back to the very first Message and then offers no more", async () => {
    const api = createMockApi().on("GET", PATH, (call: ApiCall) => {
      if (call.query?.before === "m3") return { messages: [msg(1), msg(2)], hasMore: false };
      return { messages: [msg(3), msg(4)], hasMore: true };
    });
    renderTranscript(api);
    await screen.findAllByRole("article");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("data-message-id"))).toEqual(["m1", "m2", "m3", "m4"]);
    expect(screen.queryByRole("button", { name: /Load earlier/ })).not.toBeInTheDocument();
  });

  it("shows an error when earlier Messages fail to load, keeps the button, and keeps what is shown", async () => {
    let fail = true;
    const api = createMockApi().on("GET", PATH, (call: ApiCall) => {
      if (call.query?.before) {
        if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "Page failed" });
        return { messages: [msg(1)], hasMore: false };
      }
      return { messages: [msg(2)], hasMore: true };
    });
    renderTranscript(api);
    await screen.findAllByRole("article");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page failed");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("scrolls to the newest Message on load and when a new one arrives while the reader is at the end", async () => {
    fakeLayout(500);
    let messages = [msg(1), msg(2)];
    const api = createMockApi().on("GET", PATH, (call: ApiCall) =>
      call.query?.after ? { messages: messages.filter((m) => m.id > call.query!.after!), hasMore: false } : { messages, hasMore: false },
    );
    const view = renderTranscript(api);
    await screen.findAllByRole("article");
    expect(log().scrollTop).toBe(500);

    messages = [...messages, msg(3)];
    fakeLayout(700);
    view.setRefreshKey(1);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(log().scrollTop).toBe(700);
    expect(messagesCalls(api).at(-1)).toMatchObject({ query: { after: "m2", limit: "200" } });
  });

  it("leaves a reader who scrolled up where they are when a new Message arrives", async () => {
    fakeLayout(500, 100);
    let messages = [msg(1), msg(2)];
    const api = createMockApi().on("GET", PATH, (call: ApiCall) =>
      call.query?.after ? { messages: messages.filter((m) => m.id > call.query!.after!), hasMore: false } : { messages, hasMore: false },
    );
    const view = renderTranscript(api);
    await screen.findAllByRole("article");
    log().scrollTop = 50;
    fireEvent.scroll(log());

    messages = [...messages, msg(3)];
    fakeLayout(700, 100);
    view.setRefreshKey(1);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(log().scrollTop).toBe(50);
  });

  it("keeps the reader's place when earlier Messages are added above", async () => {
    fakeLayout(500, 100);
    const api = createMockApi().on("GET", PATH, (call: ApiCall) =>
      call.query?.before ? { messages: [msg(1)], hasMore: false } : { messages: [msg(2), msg(3)], hasMore: true },
    );
    renderTranscript(api);
    await screen.findAllByRole("article");
    log().scrollTop = 0;
    fireEvent.scroll(log());
    scrollHeight = 500;
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    scrollHeight = 650; // the older Message made the list 150 taller
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(log().scrollTop).toBe(150);
  });

  it("fetches the Messages after the newest one when the Room changes, and shows each Message once", async () => {
    let messages = [msg(1)];
    const api = createMockApi().on("GET", PATH, (call: ApiCall) =>
      call.query?.after ? { messages: messages.filter((m) => m.id > call.query!.after!), hasMore: false } : { messages, hasMore: false },
    );
    const view = renderTranscript(api);
    await screen.findAllByRole("article");
    messages = [msg(1), msg(2)];
    view.setRefreshKey(1);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    // A second event with nothing new changes nothing.
    view.setRefreshKey(2);
    await waitFor(() => expect(messagesCalls(api).length).toBeGreaterThanOrEqual(3));
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("data-message-id"))).toEqual(["m1", "m2"]);
  });

  it("follows catch-up pages until there are no more", async () => {
    const api = createMockApi().on("GET", PATH, (call: ApiCall) => {
      if (call.query?.after === "m1") return { messages: [msg(2)], hasMore: true };
      if (call.query?.after === "m2") return { messages: [msg(3)], hasMore: false };
      return { messages: [msg(1)], hasMore: false };
    });
    const view = renderTranscript(api);
    await screen.findAllByRole("article");
    view.setRefreshKey(1);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
  });

  it("refetches at once when the composer announces a posted Message, even with no live event", async () => {
    let messages = [msg(1)];
    const api = createMockApi().on("GET", PATH, (call: ApiCall) =>
      call.query?.after ? { messages: messages.filter((m) => m.id > call.query!.after!), hasMore: false } : { messages, hasMore: false },
    );
    renderTranscript(api);
    await screen.findAllByRole("article");
    messages = [msg(1), msg(2)];
    act(() => announceMessagePosted("room-1"));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    // Another Room's signal does nothing.
    const before = messagesCalls(api).length;
    act(() => announceMessagePosted("another-room"));
    expect(messagesCalls(api)).toHaveLength(before);
  });

  it("collapses signals that arrive while a fetch is running into one more fetch", async () => {
    let messages = [msg(1)];
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const api = createMockApi().on("GET", PATH, async (call: ApiCall) => {
      if (call.query?.after) {
        if (gate) await gate;
        return { messages: messages.filter((m) => m.id > call.query!.after!), hasMore: false };
      }
      return { messages, hasMore: false };
    });
    renderTranscript(api);
    await screen.findAllByRole("article");
    gate = new Promise<void>((resolve) => (release = resolve));
    messages = [msg(1), msg(2)];
    act(() => {
      announceMessagePosted("room-1");
      announceMessagePosted("room-1");
      announceMessagePosted("room-1");
    });
    gate = null;
    release();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await waitFor(() => expect(messagesCalls(api).filter((c) => c.query?.after).length).toBe(2));
  });

  it("shows the error and a retry when the first load fails", async () => {
    let fail = true;
    const api = createMockApi().on("GET", PATH, () => {
      if (fail) throw new BoardroomApiError(500, { error: "internal_error", message: "Could not read" });
      return { messages: [msg(1)], hasMore: false };
    });
    renderTranscript(api);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the transcript");
    expect(alert).toHaveTextContent("Could not read");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("article")).toHaveLength(1);
  });

  it("keeps the Messages on screen and shows the error when a refresh fails", async () => {
    let fail = false;
    const api = createMockApi().on("GET", PATH, (call: ApiCall) => {
      if (call.query?.after && fail) throw new BoardroomApiError(500, { error: "internal_error", message: "Refresh broke" });
      return { messages: [msg(1)], hasMore: false };
    });
    const view = renderTranscript(api);
    await screen.findAllByRole("article");
    fail = true;
    view.setRefreshKey(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh broke");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
