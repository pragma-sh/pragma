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
export {
  ACCOUNT_PROVIDERS,
  accountProviderFromUsageLimits,
  accountProviderTitle,
  apiKeyTokenKind,
  defineAccounts,
  modelsDevAccountProviders,
  resolveAccountProviders,
  wellKnownProvider,
} from "./accounts";
export type {
  AccountContext,
  AccountIdentity,
  AccountLogin,
  AccountProviderDefinition,
  AccountSharedToken,
  AccountSwap,
  AccountUsageLimits,
  ModelsDevAccountProvider,
  ResolvedAccountProvider,
  SharedToken,
  WellKnownAccountProvider,
  WellKnownAccountProviderInfo,
} from "./accounts";
export {
  anthropicOAuthIdentity,
  apiKeyIdentity,
  chatGptIdentity,
  entryToken,
  credentialDir,
  credentialFileSharedToken,
  credentialStoreAccount,
  credentialStorePath,
  gitHubIdentity,
  identifyFromCredentialStore,
  jwtClaims,
  parseAnthropicProfile,
  readCredentialFile,
  storedCredentialIdentity,
  tokenEntry,
  writeCredentialFile,
} from "./account-identity";
export type {
  CredentialStore,
  CredentialStoreAccountOptions,
  StoredSharedTokenOptions,
  StoredCredentialOptions,
} from "./account-identity";
export {
  activateCredentialSwap,
  loginCredentialFile,
  readLoginEntries,
  sharedCredentialFile,
  writeLoginEntries,
} from "./credential-swap";
export { CLI_MISSING_STATUS, defineUsageLimitProvider, runProviderCommand } from "./usage-limits";
export type {
  ProviderCommandOutcome,
  UsageLimit,
  UsageLimitProviderDefinition,
  UsageLimitsReady,
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
