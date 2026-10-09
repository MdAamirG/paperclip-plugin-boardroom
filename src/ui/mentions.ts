/** Pure helpers of the composer's `@` mention picker. */

export interface MentionTrigger {
  /** Index of the `@` in the text. */
  start: number;
  /** What was typed after the `@`, up to the caret. */
  query: string;
}

const MAX_QUERY = 40;

/** The `@query` the caret is in (an `@` at the start or after whitespace), or null. */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^@\n]{0,40})$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  if (query.length > MAX_QUERY) return null;
  return { start: before.length - query.length - 1, query };
}

/** Replace the typed `@query` with `@Name ` and return the new text and caret. */
export function applyMention(text: string, trigger: MentionTrigger, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret);
  // Do not add a second space when one already follows the caret.
  const tail = after.startsWith(" ") ? after.slice(1) : after;
  return { text: text.slice(0, trigger.start) + inserted + tail, caret: trigger.start + inserted.length };
}

const WORD = "\\p{L}\\p{N}_";

/** True when `body` still contains `@name` as a whole mention (not inside a longer word). */
export function bodyMentions(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${WORD}])@${escaped}(?![${WORD}])`, "u").test(body);
}
