/** Bridge-free declarations safe for host-side catalog assembly. */
export { defineAgent } from "./agent";
export type { AgentDefinition, AgentModelEntry } from "./agent";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { PluginContext } from "./types";
export { defineUsageLimitProvider } from "./usage-limits";
export type { UsageLimit, UsageLimitProviderDefinition, UsageLimitsResult } from "./usage-limits";
