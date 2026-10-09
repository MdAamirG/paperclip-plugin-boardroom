import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoardroomClient, type BoardroomApi } from "../../src/ui/api.js";
import { newIdempotencyKey } from "../../src/ui/idempotency.js";
import { applyMention, bodyMentions, findMentionTrigger } from "../../src/ui/mentions.js";

describe("findMentionTrigger", () => {
  it("finds an @ at the start or after whitespace, up to the caret", () => {
    expect(findMentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(findMentionTrigger("Hi @Gr", 6)).toEqual({ start: 3, query: "Gr" });
    expect(findMentionTrigger("line\n@Ad", 8)).toEqual({ start: 5, query: "Ad" });
    // Only text before the caret counts.
    expect(findMentionTrigger("Hi @Grace and more", 6)).toEqual({ start: 3, query: "Gr" });
  });

  it("ignores an @ inside a word, a second @, and a newline in the query", () => {
    expect(findMentionTrigger("a@b", 3)).toBeNull();
    expect(findMentionTrigger("@@", 2)).toBeNull();
    expect(findMentionTrigger("@Ada\nnext", 9)).toBeNull();
    expect(findMentionTrigger("plain", 5)).toBeNull();
  });

  it("allows a space in the query so a two-word name can be filtered, up to a limit", () => {
    expect(findMentionTrigger("@Ada Lo", 7)).toEqual({ start: 0, query: "Ada Lo" });
    expect(findMentionTrigger(`@${"x".repeat(41)}`, 42)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the typed @query with @Name and a space, and puts the caret after it", () => {
    const trigger = findMentionTrigger("Hi @Gr", 6)!;
    expect(applyMention("Hi @Gr", trigger, 6, "Grace")).toEqual({ text: "Hi @Grace ", caret: 10 });
  });

  it("keeps the text after the caret and does not double the space", () => {
    const trigger = findMentionTrigger("Hi @G there", 5)!;
    expect(applyMention("Hi @G there", trigger, 5, "Grace")).toEqual({ text: "Hi @Grace there", caret: 10 });
    expect(applyMention("Hi @G\nthere", { start: 3, query: "G" }, 5, "Grace").text).toBe("Hi @Grace \nthere");
  });
});

describe("bodyMentions", () => {
  it("matches @Name as a whole mention only", () => {
    expect(bodyMentions("hello @Grace!", "Grace")).toBe(true);
    expect(bodyMentions("hello @Gracey", "Grace")).toBe(false);
    expect(bodyMentions("hello Grace", "Grace")).toBe(false);
    expect(bodyMentions("x@Grace", "Grace")).toBe(false);
    expect(bodyMentions("@R2.D2 go", "R2.D2")).toBe(true);
    expect(bodyMentions("@R2xD2 go", "R2.D2")).toBe(false);
  });
});

describe("newIdempotencyKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a uuid-shaped, different key each time", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it("still works where crypto.randomUUID is missing (plain HTTP) or crypto is missing", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.stubGlobal("crypto", undefined);
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("client message paging", () => {
  it("sends limit, before and after as query parameters next to the company id", async () => {
    const get = vi.fn(async () => ({ messages: [], hasMore: false }));
    const api = { get } as unknown as BoardroomApi;
    const client = createBoardroomClient(api, "c1");
    await client.listMessages("r1", { limit: 50, before: "m9" });
    await client.listMessages("r1", { after: "m1" });
    await client.listMessages("r1");
    expect(get.mock.calls).toEqual([
      ["/rooms/r1/messages", { limit: "50", before: "m9", companyId: "c1" }],
      ["/rooms/r1/messages", { after: "m1", companyId: "c1" }],
      ["/rooms/r1/messages", { companyId: "c1" }],
    ]);
  });
});
