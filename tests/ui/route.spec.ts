import { describe, expect, it } from "vitest";
import { boardroomPaths, parseBoardroomRoute } from "../../src/ui/route.js";

describe("parseBoardroomRoute", () => {
  it("reads the list, creation and detail routes after the company prefix", () => {
    expect(parseBoardroomRoute("/ACME/boardroom", "ACME")).toEqual({ name: "list" });
    expect(parseBoardroomRoute("/ACME/boardroom/", "ACME")).toEqual({ name: "list" });
    expect(parseBoardroomRoute("/ACME/boardroom/new", "ACME")).toEqual({ name: "new" });
    expect(parseBoardroomRoute("/ACME/boardroom/3f2c", "ACME")).toEqual({ name: "room", roomId: "3f2c" });
  });

  it("matches the prefix without regard to case and works without a prefix", () => {
    expect(parseBoardroomRoute("/acme/boardroom/new", "ACME")).toEqual({ name: "new" });
    expect(parseBoardroomRoute("/boardroom/new", null)).toEqual({ name: "new" });
  });

  it("skips the prefix by position, so a company prefixed BOARDROOM works", () => {
    expect(parseBoardroomRoute("/BOARDROOM/boardroom/abc", "BOARDROOM")).toEqual({ name: "room", roomId: "abc" });
    expect(parseBoardroomRoute("/BOARDROOM/boardroom", "BOARDROOM")).toEqual({ name: "list" });
  });

  it("reports an unknown address instead of guessing", () => {
    expect(parseBoardroomRoute("/ACME/boardroom/abc/extra", "ACME").name).toBe("unknown");
    expect(parseBoardroomRoute("/ACME/other", "ACME").name).toBe("unknown");
  });

  it("builds company-relative paths", () => {
    expect(boardroomPaths.list()).toBe("/boardroom");
    expect(boardroomPaths.create()).toBe("/boardroom/new");
    expect(boardroomPaths.room("a b")).toBe("/boardroom/a%20b");
  });
});
