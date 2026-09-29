/** Bridge-free declarations safe for host-side catalog assembly. */
export type {
  AgentArgsBuilder,
  AgentDefinition,
  AgentFeature,
  AgentLaunchSelection,
  AgentMode,
  AgentModelEntry,
  AgentOptionSource,
  AgentPermissionMode,
  AgentReasoning,
  AgentSlashCommand,
  AgentStartupInput,
  ResolvedAgentOptions,
} from "./agent";
export {
  agentLaunchArgs,
  applySlashCommand,
  dedupeSlashCommands,
  defaultSlashCommandInvocation,
  defineAgent,
  modelArgs,
  resolveAgentOptions,
  resolveAgentOptionSource,
  slashCommandInvocation,
} from "./agent";
export type { AcpCommandSource } from "./acp-discovery";
export { discoverAcpSlashCommands } from "./acp-discovery";
export type { MarkdownEntry, MarkdownSource, SlashCommandDiscovery } from "./agent-discovery";
export {
  commandAndSkillDirs,
  discoverMarkdownEntries,
  discoverSlashCommands,
  markdownModes,
  markdownSlashCommands,
  modeProvider,
  parseFrontmatter,
  slashCommandProvider,
} from "./agent-discovery";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { PluginContext, PluginProject } from "./types";
export { CLI_MISSING_STATUS, defineUsageLimitProvider, runProviderCommand } from "./usage-limits";
export type {
  ProviderCommandOutcome,
  UsageLimit,
  UsageLimitProviderDefinition,
  UsageLimitsResult,
} from "./usage-limits";
export type {
  ContextItem,
  ContextProviderDefinition,
  ContextResolveInput,
  ContextSearchInput,
  ContextWorktree,
  PromptContextBlock,
} from "./context";
export {
  CONTEXT_PICKER_LIMIT,
  ContextProviderNotice,
  contextMention,
  contextQuery,
  defineContextProvider,
  formatPromptWithContext,
  isContextProviderNotice,
  matchContextItems,
  splitPromptContext,
} from "./context";
