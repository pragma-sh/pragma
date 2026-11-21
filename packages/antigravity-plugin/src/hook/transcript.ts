// Reads agy's per-conversation transcript (`transcriptPath` in every hook
// payload: `<brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl`).
//
// Each line is one step: `{ step_index, source, type, status, content?, tool_calls? }`.
// A user turn is a `USER_INPUT` step from `USER_EXPLICIT`, whose `content`
// wraps the prompt in `<USER_REQUEST>…</USER_REQUEST>` plus metadata blocks.
// The model's visible reply is the `content` of the `PLANNER_RESPONSE` steps
// that follow it (a response carrying only `tool_calls` has no content).
//
// A cancelled step is simply never written — agy records no cancel marker — so
// aborts cannot be detected from here (the Pragma-side watcher reads the TUI).
import { asText, parseRecord } from "../json";

/** One parsed transcript step; unknown fields are ignored. */
export interface TranscriptStep {
  stepIndex: number;
  source: string;
  type: string;
  content: string | null;
}

/** The newest user turn in a transcript and the assistant text since it. */
export interface TurnSnapshot {
  /** `step_index` of the turn's user input, or -1 when none was recorded. */
  userStep: number;
  /** The prompt as the user typed it (wrapper blocks removed), or null. */
  prompt: string | null;
  /** Visible assistant text produced after the user input, blank-line joined. */
  assistantText: string;
}

/** Parses JSONL transcript text, skipping unreadable lines. */
export function parseTranscript(text: string): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const line of text.split("\n")) {
    const step = toStep(line, steps.length);
    if (step !== null) steps.push(step);
  }
  return steps;
}

/** One transcript line as a step, or null for a blank or unreadable line. */
function toStep(line: string, position: number): TranscriptStep | null {
  const value = line.trim() === "" ? null : parseRecord(line);
  if (value === null) return null;
  return {
    stepIndex: typeof value.step_index === "number" ? value.step_index : position,
    source: asText(value.source) ?? "",
    type: asText(value.type) ?? "",
    content: asText(value.content),
  };
}

/** Summarizes the newest explicit user turn. */
export function latestTurn(steps: TranscriptStep[]): TurnSnapshot {
  let start = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && isUserTurn(step)) {
      start = index;
      break;
    }
  }
  const user = start >= 0 ? steps[start] : undefined;
  const replies = steps
    .slice(start + 1)
    .filter((step) => step.type === "PLANNER_RESPONSE" && step.content?.trim())
    .map((step) => (step.content ?? "").trim());
  return {
    userStep: user?.stepIndex ?? -1,
    prompt: user?.content ? userRequest(user.content) : null,
    assistantText: replies.join("\n\n"),
  };
}

/** True for a step the user typed (not a sub-agent message or system input). */
function isUserTurn(step: TranscriptStep): boolean {
  return step.type === "USER_INPUT" && step.source === "USER_EXPLICIT";
}

/** Extracts the prompt from agy's `<USER_REQUEST>` wrapper. */
function userRequest(content: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (match?.[1] ?? content).trim();
}
