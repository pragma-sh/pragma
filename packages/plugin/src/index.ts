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
export type {
  PragmaActionsBridge,
  PragmaBridge,
  PragmaIconsBridge,
  PragmaUiBridge,
} from "./bridge";
export { getBridge } from "./bridge";
export type {
  CommandDefinition,
  PluginComponent,
  PluginComponentProps,
  PluginIcon,
  PluginWhen,
  SettingsPageDefinition,
  SidebarCardDefinition,
  SidebarTabDefinition,
  TopperItemDefinition,
  OpenWebViewOptions,
  WebViewDefinition,
  WebViewDefinitionInput,
  WebViewReference,
} from "./contributions";
export {
  defineCommand,
  defineSettingsPage,
  defineSidebarCard,
  defineSidebarTab,
  defineTopperItem,
  defineWebView,
  openWebView,
} from "./contributions";
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
export { PLUGIN_API_VERSION } from "./generated/version";
export {
  useAgentStatuses,
  useAgentMessages,
  useBranchStatus,
  useDirEntries,
  useEvent,
  useFileContents,
  useNotify,
  usePluginConfig,
  useProject,
  useSdk,
  useSdkQuery,
  useSessions,
  useStoredState,
  useTheme,
  useWebViewPayload,
  useWorktreeChanges,
} from "./hooks";
export type { PragmaHooksBridge } from "./hooks";
export type {
  InferConfig,
  PluginContributionStrategy,
  PluginDefinition,
  PluginDefinitionInput,
  PluginEventHandlers,
  PluginKeybindingsContributions,
  PluginSettingsContributions,
  PluginUiContributions,
} from "./plugin";
export { definePlugin } from "./plugin";
export type {
  UsageLimit,
  UsageLimitProviderDefinition,
  UsageLimitsReady,
  UsageLimitsResult,
  UsageLimitsUnavailable,
  UsageLimitsUnavailableReason,
} from "./usage-limits";
export { defineUsageLimitProvider } from "./usage-limits";
export type { ThemeColors, ThemeDefinition, ThemeMode } from "./theme";
export { defineTheme } from "./theme";
export { getTheme, listSessions, subscribeEvent, subscribeTheme } from "./runtime";
export type { PluginStorage } from "./storage";
export type { WatcherContext, WatcherDefinition } from "./watcher";
export { defineWatcher } from "./watcher";
export type {
  PluginAgentStatusEntry,
  PluginContext,
  PluginDeepLinkEvent,
  PluginNotifyOptions,
  PluginProject,
  PluginQueryResult,
  PluginSessionSummary,
} from "./types";
export { z } from "./z";
