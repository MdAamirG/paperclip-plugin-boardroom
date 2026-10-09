/** The transcript and composer together on the Room page (ticket 05). */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardroomPage } from "../../src/ui/index.js";
import { COMPANY_ID, detailFixture, messageFixture } from "../support/ui-fixtures.js";
import { createMockApi, renderWithBoardroom, sdkUi, type ApiCall } from "../support/ui.js";

const ROOM = "/rooms/room-1";
const MESSAGES = "/rooms/room-1/messages";

describe("Room page: notes and transcript", () => {
  it("shows a posted note in the transcript at once, then the live event brings no duplicate", async () => {
    const stored = [messageFixture({ id: "m1", body: "Earlier note" })];
    const api = createMockApi()
      .on("GET", ROOM, detailFixture())
      .on("GET", "/rooms/room-1/rounds", { rounds: [] })
      .on("GET", MESSAGES, (call: ApiCall) =>
        call.query?.after ? { messages: stored.filter((m) => m.id > call.query!.after!), hasMore: false } : { messages: stored, hasMore: false },
      )
      .on("POST", MESSAGES, (call: ApiCall) => {
        const message = messageFixture({ id: "m2", body: (call.body as { body: string }).body });
        stored.push(message);
        return { message, round: null, ignoredMentions: [] };
      });
    sdkUi.setLocation("/C1/boardroom/room-1");
    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });

    await screen.findByText("Earlier note");
    fireEvent.change(screen.getByRole("textbox", { name: /Message/ }), { target: { value: "A new note" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const transcript = within(screen.getByRole("log", { name: "Transcript" }));
    await transcript.findByText("A new note");
    expect(transcript.getAllByRole("article")).toHaveLength(2);

    act(() => sdkUi.pushStreamEvent("boardroom", { type: "room.changed", roomId: "room-1", companyId: COMPANY_ID }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === MESSAGES && c.method === "GET").length).toBeGreaterThanOrEqual(3));
    expect(transcript.getAllByRole("article")).toHaveLength(2);
  });

  it("lets a viewer read the transcript but gives no composer", async () => {
    const api = createMockApi()
      .on("GET", ROOM, detailFixture({ permissions: { role: "viewer", canPost: false, canControl: false } }))
      .on("GET", "/rooms/room-1/rounds", { rounds: [] })
      .on("GET", MESSAGES, { messages: [messageFixture({ id: "m1", body: "Readable" })], hasMore: false });
    sdkUi.setLocation("/C1/boardroom/room-1");
    renderWithBoardroom((context) => <BoardroomPage context={context} />, { api });
    expect(await screen.findByText("Readable")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
