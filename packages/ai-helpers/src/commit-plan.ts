import type { Api, Model } from "@earendil-works/pi-ai";
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
 * Run one model's commit-plan attempt, always disposing the session afterward.
 * Throws if the model errors so the caller can fall back to the next candidate.
 */
async function tryCommitPlanModel(
  model: Model<Api>,
  options: GenerateCommitPlanOptions,
  prompt: string,
): Promise<CommitPlanDraft> {
  const { session } = await createPragmaSession({
    modelKind: "standard",
    model,
    cwd: options.cwd,
    authStorage: options.authStorage,
    registry: options.registry,
  });
  try {
    const raw = await runPromptToText(session, prompt);
    return cleanCommitPlanDraft(raw);
  } finally {
    session.dispose();
  }
}

/** Tries each candidate model in order, throwing the last error if all fail. */
async function runCommitPlanWithFallbacks(
  candidates: Model<Api>[],
  options: GenerateCommitPlanOptions,
  prompt: string,
): Promise<CommitPlanDraft> {
  let lastError: unknown;
  for (const model of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- fallbacks are intentionally serial to avoid charging multiple providers for one plan.
    try {
      return await tryCommitPlanModel(model, options, prompt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

  return runCommitPlanWithFallbacks(candidates, options, prompt);
}
