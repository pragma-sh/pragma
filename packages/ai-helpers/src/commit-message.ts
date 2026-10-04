import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { buildCommitMessagePrompt, cleanCommitMessage } from "./prompts.ts";
import { runPromptWithFallback } from "./session.ts";

/** Options for {@link generateCommitMessage}. */
export interface GenerateCommitMessageOptions {
  /** The staged diff (`git diff --cached`). */
  stagedDiff: string;
  /** Worktree root — used for AGENTS.md/skill context. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
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
    {
      modelKind: "fast",
      cwd: options.cwd,
      authStorage: options.authStorage,
      registry: options.registry,
    },
    buildCommitMessagePrompt(options.stagedDiff),
    cleanCommitMessage,
  );
}
