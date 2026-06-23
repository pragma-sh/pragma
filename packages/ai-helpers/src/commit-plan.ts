import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  buildCommitPlanPrompt,
  cleanCommitPlanDraft,
  type CommitPlanDraft,
  type CommitPlanPromptContext,
} from "./prompts.ts";
import { selectModelCandidates } from "./pick-model.ts";
import { createPragmaSession, runPromptToText } from "./session.ts";

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
export async function generateCommitPlan(
  options: GenerateCommitPlanOptions,
): Promise<CommitPlanDraft> {
  if (options.allowedPaths.length === 0) {
    throw new NoWorktreeChangesError();
  }

  const prompt = buildCommitPlanPrompt(options);
  const candidates = selectModelCandidates("standard", options.registry.getAvailable());
  if (candidates.length === 0) {
    throw new Error("No standard model is available. Sign in to a provider that offers one.");
  }

  let lastError: unknown;
  for (const model of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- fallbacks are intentionally serial to avoid charging multiple providers for one plan.
    const { session } = await createPragmaSession({
      modelKind: "standard",
      model,
      cwd: options.cwd,
      authStorage: options.authStorage,
      registry: options.registry,
    });

    try {
      // oxlint-disable-next-line no-await-in-loop -- try the next model only after this one fails.
      const raw = await runPromptToText(session, prompt);
      return cleanCommitPlanDraft(raw);
    } catch (error) {
      lastError = error;
    } finally {
      session.dispose();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
