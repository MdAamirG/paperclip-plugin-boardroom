import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOTAL_TURNS, MAX_MAX_TOTAL_TURNS, MIN_MAX_TOTAL_TURNS } from "../../src/db/rooms.js";
import { MAX_ACTIVE_PARTICIPANTS } from "../../src/db/participants.js";
import { DEFAULT_TURN_CAP, MAX_PARTICIPANTS, MAX_TURN_CAP, MIN_TURN_CAP } from "../../src/ui/limits.js";

describe("UI limits", () => {
  it("match the values the server enforces", () => {
    expect(MAX_PARTICIPANTS).toBe(MAX_ACTIVE_PARTICIPANTS);
    expect(DEFAULT_TURN_CAP).toBe(DEFAULT_MAX_TOTAL_TURNS);
    expect(MIN_TURN_CAP).toBe(MIN_MAX_TOTAL_TURNS);
    expect(MAX_TURN_CAP).toBe(MAX_MAX_TOTAL_TURNS);
  });
});
