/** Bridge-free declarations safe for host-side catalog assembly. */
export { defineAgent } from "./agent";
export type { AgentDefinition, AgentFeature, AgentModelEntry } from "./agent";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { PluginContext } from "./types";
export { CLI_MISSING_STATUS, defineUsageLimitProvider, runProviderCommand } from "./usage-limits";
export type {
  ProviderCommandOutcome,
  UsageLimit,
  UsageLimitProviderDefinition,
  UsageLimitsResult,
} from "./usage-limits";
