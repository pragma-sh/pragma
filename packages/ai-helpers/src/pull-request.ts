import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  buildPullRequestPrompt,
  cleanPullRequestDraft,
  type PullRequestDraft,
  type PullRequestPromptContext,
} from "./prompts.ts";
import { selectModelCandidates } from "./pick-model.ts";
import { createPragmaSession, runPromptToText } from "./session.ts";

/** Options for {@link generatePullRequestDraft}. */
export interface GeneratePullRequestDraftOptions extends PullRequestPromptContext {
  /** Worktree root — used for AGENTS.md/skill context and code investigation. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
}

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
export async function generatePullRequestDraft(
  options: GeneratePullRequestDraftOptions,
): Promise<PullRequestDraft> {
  if (!options.gitLog.trim() && !options.committedDiff.trim()) {
    throw new NoCommittedChangesError();
  }

  const prompt = buildPullRequestPrompt(options);
  const candidates = selectModelCandidates("standard", options.registry.getAvailable());
  if (candidates.length === 0) {
    throw new Error("No standard model is available. Sign in to a provider that offers one.");
  }

  let lastError: unknown;
  for (const model of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- fallbacks are intentionally serial to avoid charging multiple providers for one draft.
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
      return cleanPullRequestDraft(raw);
    } catch (error) {
      lastError = error;
    } finally {
      session.dispose();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
