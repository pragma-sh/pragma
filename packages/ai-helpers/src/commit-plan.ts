import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  buildCommitPlanPrompt,
  cleanCommitPlanDraft,
  type CommitPlanDraft,
  type CommitPlanPromptContext,
} from "./prompts.ts";
import { runPromptWithFallback } from "./session.ts";

/** Options for {@link generateCommitPlan}. */
export interface GenerateCommitPlanOptions extends CommitPlanPromptContext {
  /** Worktree root — used for AGENTS.md/skill context and code investigation. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
}

/** Raised when there are no changes to group into commits. */
export class NoWorktreeChangesError extends Error {
  constructor() {
    super("No changes to commit.");
    this.name = "NoWorktreeChangesError";
  }
}

/**
 * Generate a logical multi-commit plan for the entire dirty worktree using a
 * standard model. Tools are left enabled so the agent can inspect changed code
 * when the status and diff are not enough to group files correctly.
 */
export function generateCommitPlan(options: GenerateCommitPlanOptions): Promise<CommitPlanDraft> {
  if (options.allowedPaths.length === 0) {
    throw new NoWorktreeChangesError();
  }

  return runPromptWithFallback(
    {
      modelKind: "standard",
      cwd: options.cwd,
      authStorage: options.authStorage,
      registry: options.registry,
    },
    buildCommitPlanPrompt(options),
    cleanCommitPlanDraft,
  );
}
