import { act, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useHostContext, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { BoardroomApiError, createBoardroomApi, useBoardroomApi } from "../../src/ui/api.js";
import { createMockApi, renderWithBoardroom, sdkUi } from "../support/ui.js";

function RoomCount() {
  const api = useBoardroomApi();
  const [text, setText] = useState("loading");
  useEffect(() => {
    api.get<{ rooms: unknown[] }>("/rooms").then(
      (res) => setText(`${res.rooms.length} rooms`),
      (err: Error) => setText(`error: ${err.message}`),
    );
  }, [api]);
  return <p>{text}</p>;
}

function StreamCount() {
  const { events } = usePluginStream<{ type: string }>("rooms");
  const { userId } = useHostContext();
  return (
    <p>
      {userId}: {events.length} updates
    </p>
  );
}

describe("mocked API client", () => {
  it("serves mocked responses and records requests", async () => {
    const api = createMockApi().on("GET", "/rooms", { rooms: [{ id: "r1" }, { id: "r2" }] });
    renderWithBoardroom(() => <RoomCount />, { api });

    expect(await screen.findByText("2 rooms")).toBeInTheDocument();
    expect(api.calls).toEqual([{ method: "GET", path: "/rooms", query: undefined, body: undefined }]);
  });

  it("fails loudly for an unmocked route", async () => {
    renderWithBoardroom(() => <RoomCount />, { api: createMockApi() });
    expect(await screen.findByText("error: Unmocked Boardroom API call: GET /rooms")).toBeInTheDocument();
  });

  it("can answer with an API error", async () => {
    const api = createMockApi().on("GET", "/rooms", () => {
      throw new BoardroomApiError(403, { error: "Forbidden" });
    });
    renderWithBoardroom(() => <RoomCount />, { api });
    expect(await screen.findByText("error: Forbidden")).toBeInTheDocument();
  });
});

describe("mocked SDK UI hooks", () => {
  it("delivers pushed stream events and host context", async () => {
    renderWithBoardroom(() => <StreamCount />, { hostContext: { userId: "user-7" } });
    expect(screen.getByText("user-7: 0 updates")).toBeInTheDocument();

    act(() => sdkUi.pushStreamEvent("rooms", { type: "room.changed" }));
    await waitFor(() => expect(screen.getByText("user-7: 1 updates")).toBeInTheDocument());
  });
});

describe("real API client", () => {
  it("calls the plugin's scoped API routes with JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "r1" }), { status: 201 }));
    const api = createBoardroomApi({ fetch: fetchMock });

    await expect(api.post("/rooms", { title: "Pricing" })).resolves.toEqual({ id: "r1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/mdaamirg.boardroom/api/rooms", {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ title: "Pricing" }),
    });
  });

  it("adds query strings and surfaces the host's error message", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: "Room not found" }), { status: 404 }),
    );
    const api = createBoardroomApi({ fetch: fetchMock });

    const failure = api.get("/rooms", { status: "open" });
    await expect(failure).rejects.toBeInstanceOf(BoardroomApiError);
    await expect(failure).rejects.toMatchObject({ status: 404, message: "Room not found" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/plugins/mdaamirg.boardroom/api/rooms?status=open");
  });
});
