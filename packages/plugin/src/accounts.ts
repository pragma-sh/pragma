import type { PluginIcon } from "./contributions";
import type { PluginContext } from "./types";
import type { UsageLimitProviderDefinition, UsageLimitsResult } from "./usage-limits";

/** A key for a well-known account provider (see {@link ACCOUNT_PROVIDERS}). */
export type WellKnownAccountProvider =
  | "anthropic"
  | "openai"
  | "cursor"
  | "github-copilot"
  | "xai"
  | "jetbrains"
  | "opencode-go"
  | "opencode-zen"
  | "moonshot"
  | "moonshot-platform"
  | "google"
  | "openrouter"
  | "deepseek"
  | "groq"
  | "mistral"
  | "cerebras"
  | "fireworks"
  | "together"
  | "huggingface"
  | "nvidia"
  | "vercel-ai-gateway"
  | "zai"
  | "minimax"
  | "xiaomi";

/** Display metadata for a well-known account provider. */
export interface WellKnownAccountProviderInfo {
  title: string;
  /** Where the user manages this provider's keys or usage; the default `dashboardUrl`. */
  dashboardUrl?: string;
  /**
   * The provider's API-key ids in the models.dev catalog, most specific first
   * (a coding plan before the pay-as-you-go API, global before regional).
   * OpenCode and Kimi Code name their providers by these ids. Only set for a
   * provider that sells keys for use in any client.
   */
  modelsDevIds?: readonly [string, ...string[]];
}

/**
 * Well-known account provider keys. Plugins that declare the same key are
 * merged into one row in Pragma's Account providers menu, so OpenCode, Pi and
 * Prime Agent holding the same OpenRouter key all show up under "OpenRouter".
 *
 * Only list a provider whose credentials may be used outside its own
 * first-party harness. A subscription sign-in that the provider restricts to
 * its own apps (Claude Free/Pro/Max, Gemini CLI or Antigravity OAuth) must not
 * be identified by any other harness — see `identifyFromCredentialStore`'s
 * `apiKeyOnly`.
 */
export const ACCOUNT_PROVIDERS: Readonly<
  Record<WellKnownAccountProvider, WellKnownAccountProviderInfo>
> = {
  anthropic: { title: "Anthropic", modelsDevIds: ["anthropic"] },
  openai: { title: "OpenAI", modelsDevIds: ["openai"] },
  cursor: { title: "Cursor" },
  "github-copilot": { title: "GitHub Copilot" },
  xai: { title: "xAI", dashboardUrl: "https://console.x.ai", modelsDevIds: ["xai"] },
  jetbrains: { title: "JetBrains" },
  "opencode-go": { title: "OpenCode Go", modelsDevIds: ["opencode-go"] },
  "opencode-zen": {
    title: "OpenCode Zen",
    dashboardUrl: "https://opencode.ai/auth",
    modelsDevIds: ["opencode"],
  },
  moonshot: { title: "Moonshot", modelsDevIds: ["kimi-code-plan-global", "kimi-code-plan-cn"] },
  "moonshot-platform": {
    title: "Moonshot AI Platform",
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys",
    modelsDevIds: ["moonshotai", "moonshotai-cn"],
  },
  google: {
    title: "Google Gemini API",
    dashboardUrl: "https://aistudio.google.com/apikey",
    modelsDevIds: ["google"],
  },
  openrouter: {
    title: "OpenRouter",
    dashboardUrl: "https://openrouter.ai/settings/keys",
    modelsDevIds: ["openrouter"],
  },
  deepseek: {
    title: "DeepSeek",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    modelsDevIds: ["deepseek"],
  },
  groq: { title: "Groq", dashboardUrl: "https://console.groq.com/keys", modelsDevIds: ["groq"] },
  mistral: {
    title: "Mistral",
    dashboardUrl: "https://console.mistral.ai/api-keys",
    modelsDevIds: ["mistral"],
  },
  cerebras: {
    title: "Cerebras",
    dashboardUrl: "https://cloud.cerebras.ai",
    modelsDevIds: ["cerebras"],
  },
  fireworks: {
    title: "Fireworks AI",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    modelsDevIds: ["fireworks-ai"],
  },
  together: {
    title: "Together AI",
    dashboardUrl: "https://api.together.ai/settings/api-keys",
    modelsDevIds: ["togetherai"],
  },
  huggingface: {
    title: "Hugging Face",
    dashboardUrl: "https://huggingface.co/settings/tokens",
    modelsDevIds: ["huggingface"],
  },
  nvidia: { title: "NVIDIA", dashboardUrl: "https://build.nvidia.com", modelsDevIds: ["nvidia"] },
  "vercel-ai-gateway": {
    title: "Vercel AI Gateway",
    dashboardUrl: "https://vercel.com/dashboard/ai-gateway",
    modelsDevIds: ["vercel"],
  },
  zai: {
    title: "Z.ai",
    dashboardUrl: "https://z.ai/manage-apikey/apikey-list",
    modelsDevIds: ["zai-coding-plan", "zai", "zhipuai"],
  },
  minimax: {
    title: "MiniMax",
    dashboardUrl: "https://platform.minimax.io",
    modelsDevIds: ["minimax-coding-plan", "minimax", "minimax-cn-coding-plan", "minimax-cn"],
  },
  xiaomi: {
    title: "Xiaomi MiMo",
    dashboardUrl: "https://platform.xiaomimimo.com",
    modelsDevIds: [
      "xiaomi",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
      "xiaomi-token-plan-cn",
    ],
  },
};

/** A well-known API-key provider and its models.dev ids. */
export interface ModelsDevAccountProvider {
  provider: WellKnownAccountProvider;
  modelsDevIds: readonly [string, ...string[]];
}

/**
 * Every well-known provider sold as an API key, with its models.dev ids, for
 * a harness that names providers the models.dev way (OpenCode, Kimi Code).
 * Leave out the ones the harness signs in to some other way.
 */
export function modelsDevAccountProviders(
  except: readonly WellKnownAccountProvider[] = [],
): ModelsDevAccountProvider[] {
  return (Object.keys(ACCOUNT_PROVIDERS) as WellKnownAccountProvider[]).flatMap((provider) => {
    const { modelsDevIds } = ACCOUNT_PROVIDERS[provider];
    return modelsDevIds && !except.includes(provider) ? [{ provider, modelsDevIds }] : [];
  });
}

/** Who a login is signed in as, reported by the plugin so Pragma can merge duplicates. */
export interface AccountIdentity {
  /** Stable id for this account at the provider (organization or user id). */
  id: string;
  email?: string;
  name?: string;
  /** Human plan name, e.g. "Max 20×" or "Team". */
  plan?: string;
}

/** How Pragma signs a new login in for an account provider. */
export interface AccountLogin {
  /** Argv run in a terminal with the login's env. It is expected to open the browser. */
  command: string[];
  /** Optional text shown while the command runs, e.g. "Paste the code shown after signing in". */
  instructions?: string;
  /**
   * Lines typed into the login terminal once the command has started, each
   * followed by Enter — for a harness that signs in from inside its TUI (Pi's
   * `/login openai-codex`). An empty string presses Enter alone.
   */
  input?: string[];
  /** How long to wait before the first `input` line, and between lines. Defaults to 2500 ms. */
  inputDelayMs?: number;
}

/**
 * Account switching for a harness that keeps every provider's credential in
 * one shared file (OpenCode's and Pi's `auth.json`), where `env` cannot give a
 * single provider a directory of its own.
 *
 * Before every launch Pragma calls `activate`, which puts the bound login's
 * credential into the shared file and saves the one it replaces back to the
 * login it belongs to. A new login signs in in place: Pragma activates the new
 * (still empty) login first, so the current sign-in is saved, then runs the
 * login command, which writes the new credential into the shared file.
 * Because the file is shared, sessions that are already running follow a
 * switch too.
 */
export interface AccountSwap<TConfig = unknown> {
  /**
   * Puts `ctx.account`'s credential into the harness's shared file
   * (`ctx.account.home` is `null` for the harness's own sign-in; an empty
   * login signs the harness out of the provider). `ctx.account.env` is the env
   * the harness is about to launch with, so a data directory another provider
   * moved is honoured.
   */
  activate: (ctx: AccountContext<TConfig>) => Promise<void>;
}

/** The login a callback runs against. */
export interface AccountHandle {
  /** Pragma's id for this login, or `"default"` for the harness's own existing login. */
  loginId: string;
  /** Pragma-owned credential directory, or `null` for the harness's own default location. */
  home: string | null;
  /** Environment that selects this login; already applied to `ctx.sdk.exec.run`. */
  env: Record<string, string>;
}

/** Context for account callbacks. `sdk.exec.run` already carries `account.env`. */
export interface AccountContext<TConfig = unknown> extends PluginContext<TConfig> {
  account: AccountHandle;
}

/**
 * A sign-in in a harness-neutral shape, so one harness can use another's:
 * an OAuth sign-in through the same OAuth client (ChatGPT in Codex, OpenCode
 * and Pi), or an API key, which any harness of that provider can hold.
 */
export type SharedToken =
  | {
      type: "oauth";
      access: string;
      refresh: string;
      /** Unix time in milliseconds when `access` expires; the newer token expires later. */
      expires: number;
      /** The provider's account id, when the harness records it. */
      accountId?: string;
      /** OpenID token, when the harness keeps it (Codex needs one). */
      idToken?: string;
    }
  | { type: "api"; key: string };

/**
 * Reads and writes a login's sign-in as a {@link SharedToken}, so an account
 * signed in through one harness can be used by another without signing in
 * again. Pragma links such copies; OAuth copies are kept on the newest token,
 * because providers rotate refresh tokens. API keys never change, so they are
 * copied once.
 *
 * Only share what the provider allows outside its own harness: never a
 * Claude Free/Pro/Max or Gemini CLI/Antigravity OAuth sign-in.
 */
export interface AccountSharedToken<TConfig = unknown> {
  /**
   * Providers with the same kind exchange tokens. Name an OAuth kind after the
   * OAuth client (`chatgpt`, `github-copilot:<client id>`); tokens of one
   * client are not handed to another. API keys use `key:<provider>`.
   */
  kind: string;
  /** The login's current token, or null when it is signed out. */
  read: (ctx: AccountContext<TConfig>) => Promise<SharedToken | null>;
  /**
   * Stores `token` as this login's sign-in. Without it the harness only lends
   * its sign-in to others (its own store has no per-account slots).
   */
  write?: (ctx: AccountContext<TConfig>, token: SharedToken) => Promise<void>;
}

/** The {@link AccountSharedToken} kind for an API key of `provider`. */
export function apiKeyTokenKind(provider: string): string {
  return `key:${provider}`;
}

/** Usage limits reported for one account. */
export interface AccountUsageLimits<TConfig = unknown> {
  /** Category rendered in the account's collapsed row. */
  primaryLimitId: string;
  /** Requested refresh cadence. The host may enforce a larger minimum. */
  refreshIntervalMs?: number;
  load: (ctx: AccountContext<TConfig>) => Promise<UsageLimitsResult>;
}

/** One account provider a plugin's harness can sign in to. */
export interface AccountProviderDefinition<TConfig = unknown> {
  /** Well-known key (see {@link ACCOUNT_PROVIDERS}) or a plugin-specific one. */
  provider: WellKnownAccountProvider | (string & {});
  /** Display title. Defaults to the well-known provider's title. */
  title?: string;
  /** Agent id in this plugin that uses these accounts. Defaults to every agent the plugin declares. */
  agent?: string;
  /**
   * Absolute URL for viewing this account's usage in the provider's dashboard.
   * Defaults to the well-known provider's dashboard.
   */
  dashboardUrl?: string;
  icon?: PluginIcon;
  /** Browser URL, absolute path, or plugin-directory-relative asset path. */
  iconPath?: string;
  login?: AccountLogin;
  /**
   * Environment that points the harness at a Pragma-owned credential directory.
   * Declaring it enables multiple accounts per harness; without it the harness
   * has exactly one (default) login.
   */
  env?: (home: string) => Record<string, string>;
  /**
   * Multiple accounts for a provider that shares one credential file with the
   * harness's other providers (see {@link AccountSwap}). Ignored when `env` is set.
   */
  swap?: AccountSwap<TConfig>;
  /**
   * Lets the harness use an account another harness signed in to, by copying
   * the sign-in (see {@link AccountSharedToken}). Needs `env` or `swap`, so
   * the copy has a login of its own.
   */
  sharedToken?: AccountSharedToken<TConfig>;
  /** Where this login's token lives. Pragma persists the path, never the token. */
  credentialPath?: (home: string | null) => string;
  /**
   * Whether the installed harness still offers this provider, asked of the
   * harness itself (e.g. its provider catalog). A provider it no longer offers
   * is not listed, so it cannot be signed in to or applied at launch. Omit it
   * when the harness has no supported way to say; the declaration then stands.
   * A throw keeps the provider listed, so a transient failure hides nothing.
   */
  available?: (ctx: PluginContext<TConfig>) => Promise<boolean>;
  /** Reports who a login is signed in as, or `null` when it is signed out. */
  identify?: (ctx: AccountContext<TConfig>) => Promise<AccountIdentity | null>;
  usageLimits?: AccountUsageLimits<TConfig>;
}

/** Declares the account providers a plugin's harnesses support. */
export function defineAccounts<TConfig = unknown>(
  providers: AccountProviderDefinition<TConfig>[],
): AccountProviderDefinition<TConfig>[] {
  return providers;
}

/** An account provider after host normalization of new and legacy declarations. */
export interface ResolvedAccountProvider<
  TConfig = unknown,
> extends AccountProviderDefinition<TConfig> {
  /** Unique within the plugin: `<provider>` or `<provider>:<agent>`. */
  id: string;
  title: string;
  /** The plugin's agent ids this provider serves: its `agent`, else every declared agent. */
  agentIds: string[];
  /** True when adapted from a deprecated `defineUsageLimitProvider` declaration. */
  legacy: boolean;
}

/** The plugin fields account resolution reads. */
export interface AccountDeclarations<TConfig = unknown> {
  /** The plugin's agents: a provider without `agent` serves all of them. */
  agents?: ReadonlyArray<{ id: string }>;
  accounts?: AccountProviderDefinition<TConfig>[];
  usageLimits?: UsageLimitProviderDefinition<TConfig>[];
}

/**
 * Normalizes a plugin's `accounts` plus any deprecated `usageLimits` into one
 * list. Legacy providers become a single-login provider keyed by their old id;
 * one whose id is already declared through `accounts` is dropped.
 */
export function resolveAccountProviders<TConfig = unknown>(
  definition: AccountDeclarations<TConfig>,
): ResolvedAccountProvider<TConfig>[] {
  const agents = definition.agents ?? [];
  const resolved = (definition.accounts ?? []).map((provider) => resolveDeclared(provider, agents));
  const declared = new Set(resolved.map((provider) => provider.provider));
  for (const legacy of definition.usageLimits ?? []) {
    if (!declared.has(legacy.id)) {
      resolved.push({
        ...accountProviderFromUsageLimits(legacy),
        agentIds: agents.map((agent) => agent.id),
      });
    }
  }
  return resolved;
}

/** Adapts a deprecated usage-limit provider into a single-login account provider. */
export function accountProviderFromUsageLimits<TConfig = unknown>(
  legacy: UsageLimitProviderDefinition<TConfig>,
): Omit<ResolvedAccountProvider<TConfig>, "agentIds"> {
  return {
    id: legacy.id,
    provider: legacy.id,
    title: legacy.title,
    dashboardUrl: legacy.dashboardUrl,
    ...(legacy.icon === undefined ? {} : { icon: legacy.icon }),
    ...(legacy.iconPath === undefined ? {} : { iconPath: legacy.iconPath }),
    usageLimits: {
      primaryLimitId: legacy.primaryLimitId,
      ...(legacy.refreshIntervalMs === undefined
        ? {}
        : { refreshIntervalMs: legacy.refreshIntervalMs }),
      load: (ctx) => legacy.load(ctx),
    },
    legacy: true,
  };
}

/** Title for a provider key, falling back to the key itself. */
export function accountProviderTitle(provider: string, title?: string): string {
  if (title) return title;
  return wellKnownProvider(provider)?.title ?? provider;
}

/** Metadata for a well-known provider key, or undefined for a plugin-specific one. */
export function wellKnownProvider(provider: string): WellKnownAccountProviderInfo | undefined {
  return Object.hasOwn(ACCOUNT_PROVIDERS, provider)
    ? ACCOUNT_PROVIDERS[provider as WellKnownAccountProvider]
    : undefined;
}

function resolveDeclared<TConfig>(
  provider: AccountProviderDefinition<TConfig>,
  agents: NonNullable<AccountDeclarations["agents"]>,
): ResolvedAccountProvider<TConfig> {
  const agentIds = provider.agent ? [provider.agent] : agents.map((agent) => agent.id);
  const dashboardUrl = provider.dashboardUrl ?? wellKnownProvider(provider.provider)?.dashboardUrl;
  return {
    ...provider,
    ...(dashboardUrl ? { dashboardUrl } : {}),
    id: provider.agent ? `${provider.provider}:${provider.agent}` : provider.provider,
    title: accountProviderTitle(provider.provider, provider.title),
    agentIds,
    legacy: false,
  };
}
