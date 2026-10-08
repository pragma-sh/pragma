import { buildCommitMessagePrompt, cleanCommitMessage } from "./prompts.ts";
import { type AiFeatureContext, featureRunOptions } from "./feature-context.ts";
import { runPromptWithFallback } from "./session.ts";

/** Options for {@link generateCommitMessage}. */
export interface GenerateCommitMessageOptions extends AiFeatureContext {
  /** The staged diff (`git diff --cached`). */
  stagedDiff: string;
  /** What the change is, when the diff cannot say (e.g. a merge-conflict resolution). */
  note?: string;
}

/** Raised when there is nothing staged to summarize. */
export class NoStagedChangesError extends Error {
  constructor() {
    super("No staged changes to generate a commit message from.");
    this.name = "NoStagedChangesError";
  }
}

/**
 * Generate a Conventional Commits message from a staged diff using a fast
 * (non-reasoning) model. Throws {@link NoStagedChangesError} when the diff is
 * empty.
 */
export function generateCommitMessage(options: GenerateCommitMessageOptions): Promise<string> {
  if (!options.stagedDiff.trim()) {
    throw new NoStagedChangesError();
  }

  return runPromptWithFallback(
    featureRunOptions(options, "fast"),
    buildCommitMessagePrompt(options.stagedDiff, options.note),
    cleanCommitMessage,
  );
}
