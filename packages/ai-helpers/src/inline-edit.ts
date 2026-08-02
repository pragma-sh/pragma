import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
  buildInlineEditPrompt,
  cleanInlineEditDraft,
  type InlineEditDraft,
  type InlineEditPromptContext,
} from "./prompts.ts";
import { runPromptWithFallback } from "./session.ts";

/**
 * Tools an inline edit may use. Read-only on purpose: the buffer being edited is
 * usually unsaved, so a model that wrote to disk would be editing a different
 * document than the one the user sees. `write`/`edit`/`bash` are therefore left
 * out and the model answers with replacements instead.
 */
export const INLINE_EDIT_TOOLS = ["read", "grep", "find", "ls"];

/** Options for {@link generateInlineEdit}. */
export interface GenerateInlineEditOptions extends InlineEditPromptContext {
  /** Worktree root — the codebase the read-only tools may search. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
}

/** Raised when the user submitted an empty instruction. */
export class NoInstructionError extends Error {
  constructor() {
    super("No instruction to edit with.");
    this.name = "NoInstructionError";
  }
}

/**
 * Turn a highlighted region plus a natural-language instruction into exact-text
 * replacements for the buffer, using a standard model. Tools are limited to
 * {@link INLINE_EDIT_TOOLS} so the agent can research the whole repository but
 * cannot change it; applying the result is the caller's job.
 */
export function generateInlineEdit(options: GenerateInlineEditOptions): Promise<InlineEditDraft> {
  if (!options.instruction.trim()) {
    throw new NoInstructionError();
  }

  return runPromptWithFallback(
    {
      modelKind: "standard",
      cwd: options.cwd,
      authStorage: options.authStorage,
      registry: options.registry,
      tools: INLINE_EDIT_TOOLS,
    },
    buildInlineEditPrompt(options),
    cleanInlineEditDraft,
  );
}
