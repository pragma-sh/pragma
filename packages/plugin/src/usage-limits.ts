import type {
  UsageLimit,
  UsageLimitsReady,
  UsageLimitsResult,
  UsageLimitsUnavailable,
  UsageLimitsUnavailableReason,
} from "@pragma-sh/constants";

import type { PluginIcon } from "./contributions";
import type { PluginContext } from "./types";

// The usage-limit result shapes are wire types: the host validates and caches
// them, and desktop, mobile, and web all render the same JSON. They therefore
// live in `@pragma-sh/constants` and are only re-exported here, so plugin authors
// import one name and no second definition can drift from it.
export type {
  UsageLimit,
  UsageLimitsReady,
  UsageLimitsResult,
  UsageLimitsUnavailable,
  UsageLimitsUnavailableReason,
};

/**
 * Exit status a provider's shell wrapper uses to report that the agent CLI is
 * not on PATH, distinguishing "not installed" from a genuine command failure.
 */
export const CLI_MISSING_STATUS = 20;

/** Outcome of one provider CLI invocation. */
export type ProviderCommandOutcome =
  | { kind: "missing" }
  /** Non-zero exit. `stderr` is trimmed and may be empty. */
  | { kind: "failed"; stderr: string }
  | { kind: "ok"; stdout: string };

/**
 * Runs a single provider command in the active project and classifies its exit
 * status. Callers map `missing`/`failed` onto their own messages, since the
 * wording and the reasons worth special-casing differ per agent.
 */
export async function runProviderCommand<TConfig>(
  ctx: PluginContext<TConfig>,
  command: string,
  missingStatus: number = CLI_MISSING_STATUS,
): Promise<ProviderCommandOutcome> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [command],
  });
  if (result?.status === missingStatus) return { kind: "missing" };
  if (!result || result.status !== 0) {
    return { kind: "failed", stderr: result?.stderr.trim() ?? "" };
  }
  return { kind: "ok", stdout: result.stdout };
}

/**
 * A plugin-owned usage source rendered by Pragma's shared usage-limits UI.
 * @deprecated Declare an account provider with `defineAccounts` and put these
 * fields under its `usageLimits`.
 */
export interface UsageLimitProviderDefinition<TConfig = unknown> {
  id: string;
  title: string;
  /** Absolute URL for viewing this provider's usage in its dashboard. */
  dashboardUrl: string;
  icon?: PluginIcon;
  /** Browser URL, absolute path, or plugin-directory-relative asset path. */
  iconPath?: string;
  /** Category rendered in the provider's collapsed summary row. */
  primaryLimitId: string;
  /** Requested refresh cadence. The host may enforce a larger minimum. */
  refreshIntervalMs?: number;
  load: (ctx: PluginContext<TConfig>) => Promise<UsageLimitsResult>;
}

/**
 * Declares a provider for Pragma's shared usage-limits UI.
 * @deprecated Use `defineAccounts`. The host adapts legacy providers into a
 * single-login account provider with no sign-in or switching.
 */
export function defineUsageLimitProvider<TConfig = unknown>(
  input: UsageLimitProviderDefinition<TConfig>,
): UsageLimitProviderDefinition<TConfig> {
  return input;
}
