/**
 * The one prompt a Turn sends: the Room directive plus a bounded transcript. Pure text building,
 * so it is checked through the prompt the agent receives (see `tests/api/rounds.spec.ts`).
 */

/** The transcript part stays near this many characters; older Messages are left out. */
export const TRANSCRIPT_CHAR_BUDGET = 12_000;

export interface PromptParticipant {
  name: string;
  role: string | null;
}

export interface PromptMessage {
  /** Who wrote it, as the agent should see it ("Owner", "Board member", an agent name). */
  author: string;
  body: string;
}

export interface TurnPromptInput {
  roomTitle: string;
  topic: string;
  participants: readonly PromptParticipant[];
  /** The agent this Turn runs. */
  agentName: string;
  /** Everyone addressed in this Round, in order. */
  addressedNames: readonly string[];
  /** Newest last. */
  messages: readonly PromptMessage[];
  /** How many Messages of the Room are not in `messages`, because they are older or did not fit. */
  omittedCount: number;
}

const TRUNCATED = "\n[... message cut to fit ...]";

function line(message: PromptMessage): string {
  return `[${message.author}]\n${message.body}`;
}

/**
 * Choose the latest Messages that fit the budget (newest last). The newest Message is always kept,
 * cut down if it alone is over the budget. Returns the chosen lines and how many were left out.
 */
export function fitTranscript(
  messages: readonly PromptMessage[],
  budget = TRANSCRIPT_CHAR_BUDGET,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    let text = line(messages[i]!);
    const cost = text.length + 2;
    if (used + cost > budget) {
      if (lines.length > 0) break;
      text = text.slice(0, Math.max(budget - TRUNCATED.length, 0)) + TRUNCATED;
    }
    lines.unshift(text);
    used += cost;
  }
  return { lines, omitted: messages.length - lines.length };
}

export function buildTurnPrompt(input: TurnPromptInput): string {
  const { lines, omitted } = fitTranscript(input.messages);
  const omittedTotal = input.omittedCount + omitted;
  const participants = input.participants.map((p) => `- ${p.name}${p.role ? ` (${p.role})` : ""}`).join("\n");
  const parts = [
    `You are ${input.agentName}, taking part in a Boardroom discussion Room titled "${input.roomTitle}". The board is asking you for your view.`,
    `Topic:\n${input.topic}`,
    `Participants:\n${participants}`,
    `Addressed in this round: ${input.addressedNames.join(", ")}. This turn is yours.`,
    [
      "Rules for this turn:",
      "- Reply with only your Message.",
      "- You may disagree.",
      "- Do not describe your environment.",
      "- Do not call Paperclip APIs or create work during this turn.",
    ].join("\n"),
    omittedTotal > 0
      ? `Transcript (latest messages, newest last; ${omittedTotal} older message${omittedTotal === 1 ? " was" : "s were"} left out):`
      : "Transcript (newest last):",
    lines.join("\n\n"),
  ];
  return parts.join("\n\n");
}
