/** The Room list reports the actor's rights, so the UI can hide "New Room" from viewers. */
import { afterEach, describe, expect, it } from "vitest";
import type { RoomListResponse } from "../../src/api/types.js";
import { createBoardroomHarness, type BoardroomHarness } from "../support/harness.js";

let harness: BoardroomHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("GET /rooms permissions", () => {
  it("reports the role and whether the actor can post", async () => {
    harness = await createBoardroomHarness();
    const company = await harness.seedCompany();
    const list = async (role: "owner" | "operator" | "viewer") =>
      (await harness!.request<RoomListResponse>("GET", "/rooms", { query: { companyId: company.id }, actor: company.members[role] })).body;

    expect((await list("owner")).permissions).toEqual({ role: "owner", canPost: true });
    expect((await list("operator")).permissions).toEqual({ role: "operator", canPost: true });
    expect((await list("viewer")).permissions).toEqual({ role: "viewer", canPost: false });
  });
});
