import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { buildCommitMessagePrompt, cleanCommitMessage } from "./prompts.ts";
import { selectModelCandidates } from "./pick-model.ts";
import { createPragmaSession, runPromptToText } from "./session.ts";

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
 * Generate a Conventional Commits message from a staged diff using a quick
 * (non-reasoning) model. Throws {@link NoStagedChangesError} when the diff is
 * empty.
 */
export async function generateCommitMessage(
  options: GenerateCommitMessageOptions,
): Promise<string> {
  if (!options.stagedDiff.trim()) {
    throw new NoStagedChangesError();
  }

  const prompt = buildCommitMessagePrompt(options.stagedDiff);
  const candidates = selectModelCandidates("quick", options.registry.getAvailable());
  if (candidates.length === 0) {
    throw new Error("No quick model is available. Sign in to a provider that offers one.");
  }

  let lastError: unknown;
  for (const model of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- fallbacks are intentionally serial to avoid charging multiple providers for one message.
    const { session } = await createPragmaSession({
      modelKind: "quick",
      model,
      cwd: options.cwd,
      authStorage: options.authStorage,
      registry: options.registry,
    });

    try {
      // oxlint-disable-next-line no-await-in-loop -- try the next model only after this one fails.
      const raw = await runPromptToText(session, prompt);
      return cleanCommitMessage(raw);
    } catch (error) {
      lastError = error;
    } finally {
      session.dispose();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
