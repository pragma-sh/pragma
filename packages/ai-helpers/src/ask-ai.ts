import { INLINE_EDIT_TOOLS } from "./inline-edit.ts";
import { type AskAiPromptContext, type AskAiWorktreeRef, buildAskAiPrompt } from "./prompts.ts";
import { type AiFeatureContext, featureRunOptions } from "./feature-context.ts";
import { runPromptStreamingWithFallback } from "./session.ts";

/**
 * Tools a palette Ask AI may use. Same read-only set as inline edit — the
 * answer is explanatory markdown, never a write or shell command.
 */
export const ASK_AI_TOOLS = INLINE_EDIT_TOOLS;

export type { AskAiPromptContext, AskAiWorktreeRef };

/** Options for {@link streamAskAi}. */
export interface StreamAskAiOptions extends AskAiPromptContext, AiFeatureContext {
  /**
   * Working directory for the agent session. Prefer the project's main
   * worktree root so nested checkout paths stay reachable; the prompt still
   * names every worktree path explicitly.
   */
  cwd: string;
  /** Called for each assistant text delta as it streams. */
  onDelta: (delta: string) => void;
  /** Called when a model retry or failed attempt should clear streamed text. */
  onReset?: () => void;
}

/** Raised when the user submitted an empty ask. */
export class NoQuestionError extends Error {
  constructor() {
    super("No question to ask.");
    this.name = "NoQuestionError";
  }
}

/**
 * Answer a one-shot codebase question with a standard model and read-only
 * tools. Streams text deltas; resolves with the final markdown answer.
 */
export function streamAskAi(options: StreamAskAiOptions): Promise<string> {
  if (!options.question.trim()) {
    throw new NoQuestionError();
  }

  return runPromptStreamingWithFallback(
    featureRunOptions(options, "standard", ASK_AI_TOOLS),
    buildAskAiPrompt(options),
    options.onDelta,
    options.onReset,
  );
}
