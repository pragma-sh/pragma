import type { Api, Model } from "@earendil-works/pi-ai";

import type { ModelKind } from "./constants.ts";

/**
 * How far a failed attempt generalizes.
 *
 * - `model` — this model refused the request (unsupported model id, context
 *   overflow, a bad request); a sibling model on the same provider may work.
 * - `provider` — the credential or the account is the problem (auth, quota,
 *   billing), so every other model behind it will fail exactly the same way.
 *
 * The distinction is what keeps the fallback loop from spending twenty serial
 * round-trips proving that one expired key is still expired.
 */
export type FailureScope = "model" | "provider";

/** One failed candidate attempt. */
export interface AttemptFailure {
  provider: string;
  modelId: string;
  /** The provider's message, trimmed and length-capped. */
  message: string;
  scope: FailureScope;
}

/**
 * Messages that indict the credential or the account rather than the model.
 * Matched against the provider's raw error text, which is the only signal pi
 * surfaces — the SDK flattens HTTP failures into a string.
 */
const PROVIDER_SCOPE_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /\b402\b/,
  /\b429\b/,
  /invalid api key/i,
  /unauthorized/i,
  /authentication/i,
  /credentials/i,
  /quota/i,
  /usage limit/i,
  /rate.?limit/i,
  /insufficient (credit|balance|funds)/i,
  /payment required/i,
];

/** Longest provider message kept per failure; enough to name the cause. */
const MAX_MESSAGE_CHARS = 240;

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_MESSAGE_CHARS)}…`
    : collapsed;
}

/** Whether `error` condemns the whole provider or just the model that raised it. */
export function classifyFailure(error: unknown): FailureScope {
  const message = errorText(error);
  return PROVIDER_SCOPE_PATTERNS.some((pattern) => pattern.test(message)) ? "provider" : "model";
}

/** Record one candidate's failure, classified for the fallback loop. */
export function describeFailure(model: Model<Api>, error: unknown): AttemptFailure {
  return {
    provider: model.provider,
    modelId: model.id,
    message: errorText(error),
    scope: classifyFailure(error),
  };
}

/** The first failure recorded for each provider, in the order they were tried. */
function firstPerProvider(failures: readonly AttemptFailure[]): AttemptFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    if (seen.has(failure.provider)) return false;
    seen.add(failure.provider);
    return true;
  });
}

/**
 * Raised when every candidate model of a tier failed.
 *
 * The message names **each provider's own** error rather than the last
 * candidate's: the last candidate is the worst-ranked model of whichever
 * provider happened to sort last, so its error is the least informative one in
 * the set. Reporting per provider is what turns "400 model not available" into
 * "your opencode-go key is rejected and Copilot is out of quota".
 */
export class NoWorkingModelError extends Error {
  readonly failures: readonly AttemptFailure[];

  constructor(modelKind: ModelKind, failures: readonly AttemptFailure[]) {
    const detail = firstPerProvider(failures)
      .map((failure) => `${failure.provider} (${failure.modelId}): ${failure.message}`)
      .join(" ");
    super(
      detail
        ? `Every available ${modelKind} model failed. ${detail}`
        : `Every available ${modelKind} model failed.`,
    );
    this.name = "NoWorkingModelError";
    this.failures = failures;
  }
}
