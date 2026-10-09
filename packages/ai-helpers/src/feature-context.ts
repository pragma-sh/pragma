import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelKind } from "./constants.ts";
import type { RunPromptWithFallbackOptions } from "./session.ts";

/** Where a feature's prompt runs and whose credentials reach the model. */
export interface AiFeatureContext {
  /** Working directory — drives AGENTS.md discovery, skills, and tool scope. */
  cwd: string;
  authStorage: AuthStorage;
  registry: ModelRegistry;
}

/** A feature's run options: its context on one model tier, optionally with a tool allowlist. */
export function featureRunOptions(
  context: AiFeatureContext,
  modelKind: ModelKind,
  tools?: string[],
): RunPromptWithFallbackOptions {
  const { cwd, authStorage, registry } = context;
  return { modelKind, cwd, authStorage, registry, ...(tools && { tools }) };
}
