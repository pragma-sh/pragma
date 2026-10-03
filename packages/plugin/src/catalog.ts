/** Bridge-free declarations safe for host-side catalog assembly. */
export { defineAgent } from "./agent";
export type { AgentDefinition, AgentFeature, AgentModelEntry } from "./agent";
export { definePlugin } from "./plugin";
export type { PluginDefinition } from "./plugin";
export type { PluginContext } from "./types";
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
