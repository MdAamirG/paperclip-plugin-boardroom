import { describe, expect, it } from "vitest";
import { boardroomCss } from "../../src/ui/styles.js";

describe("stylesheet (F8)", () => {
  it("does not strip bullets from Markdown lists: only lists with a br- class lose their markers", () => {
    expect(boardroomCss).toMatch(/\.br-root ul\[class\*="br-"\][^{]*\{[^}]*list-style: none/);
    expect(boardroomCss).toMatch(/\.br-root ul:not\(\[class\*="br-"\]\)\s*\{[^}]*list-style: disc/);
    expect(boardroomCss).toMatch(/\.br-root ol:not\(\[class\*="br-"\]\)\s*\{[^}]*list-style: decimal/);
    // The blanket reset that removed bullets everywhere is gone.
    expect(boardroomCss).not.toMatch(/\.br-root ul, \.br-root ol \{ list-style: none/);
  });
});
