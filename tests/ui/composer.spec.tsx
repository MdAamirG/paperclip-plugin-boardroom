import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SendMessageResponse } from "../../src/api/types.js";
import { BoardroomApiError, BoardroomApiProvider } from "../../src/ui/api.js";
import { ComposerRegion } from "../../src/ui/regions/composer.js";
import { onMessagePosted } from "../../src/ui/regions/message-bus.js";
import { COMPANY_ID, detailFixture, messageFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, type MockBoardroomApi } from "../support/ui.js";

const PATH = "/rooms/room-1/messages";

const sent = (): SendMessageResponse => ({ message: messageFixture({ id: "new" }), round: null, ignoredMentions: [] });

function renderComposer(api: MockBoardroomApi, detail = detailFixture(), reloadRoom = () => {}) {
  return renderWithBoardroom(() => <ComposerRegion companyId={COMPANY_ID} detail={detail} refreshKey={0} reloadRoom={reloadRoom} />, { api });
}

const box = () => screen.getByRole("textbox", { name: /Message/ }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const sendButton = () => screen.getByRole("button", { name: /^Send|Sending/ });
const posts = (api: MockBoardroomApi) => api.calls.filter((c) => c.method === "POST" && c.path === PATH);
const optionNames = () => within(screen.getByRole("listbox", { name: "Mention a Participant" })).getAllByRole("option").map((o) => o.textContent);

describe("Composer: mention picker", () => {
  it("opens on @ and lists only the active Participants of the Room", () => {
    renderComposer(createMockApi());
    type("Hello @");
    expect(optionNames()).toEqual(["Adacto", "Graceengineer"]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("does not offer a Participant that has no name (its agent record is gone)", () => {
    const base = detailFixture();
    const detail = detailFixture({ participants: [...base.participants, { id: "p3", agentId: "agent-3", name: null, role: null, title: null, addedByUserId: "u", addedAt: base.participants[0]!.addedAt }] });
    renderComposer(createMockApi(), detail);
    type("@");
    expect(optionNames()).toHaveLength(2);
  });

  it("filters by what is typed after the @ and closes when nothing matches or the @ is mid-word", () => {
    renderComposer(createMockApi());
    type("@gr");
    expect(optionNames()).toEqual(["Graceengineer"]);
    type("@zzz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    type("mail me at a@");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    type("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("inserts the name on click and sends the agent id in mentions", async () => {
    const api = createMockApi().on("POST", PATH, sent());
    renderComposer(api);
    type("Thoughts @gr");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Grace/ }));
    expect(box().value).toBe("Thoughts @Grace ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    type("Thoughts @Grace please");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toMatchObject({ companyId: COMPANY_ID, body: "Thoughts @Grace please", mentions: ["agent-2"] });
    expect(typeof (posts(api)[0]!.body as { idempotencyKey: string }).idempotencyKey).toBe("string");
  });

  it("works from the keyboard: arrows move, Enter picks, Escape closes", () => {
    renderComposer(createMockApi());
    type("@");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Grace/ })).toHaveAttribute("aria-selected", "true");
    expect(box()).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /Grace/ }).id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Ada/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@Grace ");

    type("@");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box().value).toBe("@");
  });

  it("sends mentions in the order they were picked and drops one whose text was deleted", async () => {
    const api = createMockApi().on("POST", PATH, sent());
    renderComposer(api);
    type("@");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Grace/ }));
    type("@Grace @");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Ada/ }));
    expect(box().value).toBe("@Grace @Ada ");
    // The user deletes the Grace mention from the text before sending.
    type("hello @Ada ");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toMatchObject({ body: "hello @Ada", mentions: ["agent-1"] });
  });

  it("sends no mentions for a plain note", async () => {
    const api = createMockApi().on("POST", PATH, sent());
    renderComposer(api);
    type("just a note");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.body).toMatchObject({ body: "just a note", mentions: [] });
  });
});

describe("Composer: sending", () => {
  it("disables Send for an empty draft, sends on Ctrl+Enter, then clears the draft and refreshes", async () => {
    const api = createMockApi().on("POST", PATH, sent());
    const reloadRoom = vi.fn();
    const posted = vi.fn();
    const off = onMessagePosted("room-1", posted);
    renderComposer(api, detailFixture(), reloadRoom);
    expect(sendButton()).toBeDisabled();
    type("   ");
    expect(sendButton()).toBeDisabled();
    type("Plan **B**");
    expect(sendButton()).toBeEnabled();
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(box().value).toBe(""));
    expect(posts(api)).toHaveLength(1);
    expect(reloadRoom).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    off();
  });

  it("sends once when Send is clicked twice while the request is running", async () => {
    let release: (value: unknown) => void = () => {};
    const api = createMockApi().on("POST", PATH, () => new Promise((resolve) => (release = resolve)));
    renderComposer(api);
    type("hello");
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendButton()).toBeDisabled());
    expect(sendButton()).toHaveTextContent("Sending…");
    fireEvent.click(sendButton());
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    release(sent());
    await waitFor(() => expect(box().value).toBe(""));
    expect(posts(api)).toHaveLength(1);
  });

  it("shows the ignored-mentions notice with the reason, and can dismiss it", async () => {
    const api = createMockApi().on("POST", PATH, {
      ...sent(),
      ignoredMentions: [
        { agentId: "agent-9", name: "Linus", reason: "not_a_participant" },
        { agentId: "agent-8", name: "Margaret", reason: "removed_participant" },
        { agentId: "11111111-2222-3333-4444-555555555555", name: null, reason: "unknown_agent" },
      ],
    });
    renderComposer(api);
    type("hi @Linus");
    fireEvent.click(sendButton());
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Your message was posted, but these mentions were ignored");
    const items = within(notice).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Linus is not a Participant in this Room.",
      "Margaret was removed from this Room.",
      "Agent 11111111 is not an agent of this company.",
    ]);
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows no notice when nothing was ignored, and clears an old notice on the next send", async () => {
    let ignored = true;
    const api = createMockApi().on("POST", PATH, () => ({
      ...sent(),
      ignoredMentions: ignored ? [{ agentId: "agent-9", name: "Linus", reason: "not_a_participant" }] : [],
    }));
    renderComposer(api);
    type("one");
    fireEvent.click(sendButton());
    await screen.findByRole("status");
    ignored = false;
    type("two");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("keeps the draft and shows the error inline when a send fails", async () => {
    const api = createMockApi().on("POST", PATH, () => {
      throw new BoardroomApiError(500, { error: "internal_error", message: "The note could not be saved" });
    });
    renderComposer(api);
    type("Important point @Ada");
    fireEvent.click(sendButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your message was not sent. Your draft is kept.");
    expect(alert).toHaveTextContent("The note could not be saved");
    expect(box().value).toBe("Important point @Ada");
    expect(sendButton()).toBeEnabled();
  });

  it("reuses the idempotency key when the same send is retried, and uses a new one after an edit or a success", async () => {
    let fail = true;
    const api = createMockApi().on("POST", PATH, () => {
      if (fail) throw new BoardroomApiError(503, { error: "unavailable", message: "Try later" });
      return sent();
    });
    renderComposer(api);
    const key = (n: number) => (posts(api)[n]!.body as { idempotencyKey: string }).idempotencyKey;

    type("first draft");
    fireEvent.click(sendButton());
    await screen.findByRole("alert");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(key(1)).toBe(key(0));

    // An edited draft is a different send.
    type("first draft, edited");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(3));
    expect(key(2)).not.toBe(key(0));
    await waitFor(() => expect(sendButton()).toBeEnabled());

    // The retry succeeds with the same key, and the next message gets a fresh one.
    fail = false;
    fireEvent.click(sendButton());
    await waitFor(() => expect(box().value).toBe(""));
    expect(key(3)).toBe(key(2));
    type("first draft, edited");
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts(api)).toHaveLength(5));
    expect(key(4)).not.toBe(key(3));
  });

  it("refetches the Room when the server says the Room is closed, and keeps the draft", async () => {
    const api = createMockApi().on("POST", PATH, () => {
      throw new BoardroomApiError(409, { error: "room_closed", message: "This Room is closed, so it no longer accepts messages" });
    });
    const reloadRoom = vi.fn();
    renderComposer(api, detailFixture(), reloadRoom);
    type("too late");
    fireEvent.click(sendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("This Room is closed");
    expect(reloadRoom).toHaveBeenCalledTimes(1);
    expect(box().value).toBe("too late");
  });

  it("refuses a draft over the length limit before sending", () => {
    renderComposer(createMockApi());
    type("x".repeat(20_001));
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("longer than 20,000 characters");
  });

  it("starts empty again for another Room", async () => {
    const api = createMockApi();
    const view = renderComposer(api);
    type("draft for room 1");
    view.rerender(
      <BoardroomApiProvider api={api}>
        <ComposerRegion companyId={COMPANY_ID} detail={detailFixture({ room: { id: "room-2" } })} refreshKey={0} reloadRoom={() => {}} />
      </BoardroomApiProvider>,
    );
    await waitFor(() => expect(box().value).toBe(""));
  });
});

describe("Composer: who can post", () => {
  it("shows no text area to a viewer, and a closed-Room notice when the Room is closed", () => {
    const viewer = renderComposer(createMockApi(), detailFixture({ permissions: { role: "viewer", canPost: false, canControl: false } }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your role can read this Room but not post in it.");
    viewer.unmount();

    renderComposer(createMockApi(), detailFixture({ room: { status: "closed" }, permissions: { role: "owner", canPost: false, canControl: true } }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This Room is closed, so it is read-only.");
  });
});
