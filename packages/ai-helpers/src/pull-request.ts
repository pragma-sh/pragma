import {
  buildPullRequestPrompt,
  cleanPullRequestDraft,
  type PullRequestDraft,
  type PullRequestPromptContext,
} from "./prompts.ts";
import { type AiFeatureContext, featureRunOptions } from "./feature-context.ts";
import { runPromptWithFallback } from "./session.ts";

/** Options for {@link generatePullRequestDraft}. */
export interface GeneratePullRequestDraftOptions
  extends PullRequestPromptContext, AiFeatureContext {}

/** Raised when there are no branch commits to summarize. */
export class NoCommittedChangesError extends Error {
  constructor() {
    super("No committed changes to generate a pull request from.");
    this.name = "NoCommittedChangesError";
  }
}

/**
 * Generate a pull request title and markdown description from branch commits and
 * committed changes using a standard model. Tools are intentionally left enabled
 * so the agent can inspect code when the commits/diff are insufficient.
 */
export function generatePullRequestDraft(
  options: GeneratePullRequestDraftOptions,
): Promise<PullRequestDraft> {
  if (!options.gitLog.trim() && !options.committedDiff.trim()) {
    throw new NoCommittedChangesError();
  }

  return runPromptWithFallback(
    featureRunOptions(options, "standard"),
    buildPullRequestPrompt(options),
    cleanPullRequestDraft,
  );
}
