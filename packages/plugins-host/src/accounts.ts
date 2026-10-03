import {
  resolveAccountProviders,
  type AccountContext,
  type AccountIdentity,
  type PluginContext,
  type ResolvedAccountProvider,
  type SharedToken,
  type UsageLimitsResult,
} from "@pragma-sh/plugin/catalog";
import type { AccountProviderInfo } from "@pragma-sh/constants";
import type { PragmaClient } from "@pragma-sh/sdk";

import { qualifiedAgentId, type ResolvedPlugin } from "./catalog";

/** Sidecar `accounts` request ops, answered with one correlated `accountsResult`. */
export type AccountsOp =
  | { op: "providers"; root?: string }
  | { op: "launch"; pluginId: string; providerId: string; home: string | null; root?: string }
  | { op: "identify"; pluginId: string; providerId: string; home: string | null; root?: string }
  | { op: "usage"; pluginId: string; providerId: string; home: string | null; root?: string }
  | {
      op: "activate";
      pluginId: string;
      providerId: string;
      home: string | null;
      /** The env the harness is about to launch with. */
      env?: Record<string, string>;
      root?: string;
    }
  | { op: "readToken"; pluginId: string; providerId: string; home: string | null; root?: string }
  | {
      op: "writeToken";
      pluginId: string;
      providerId: string;
      home: string | null;
      token: SharedToken;
      root?: string;
    };

/** What a login needs to run and to launch its harness. */
export interface AccountLaunch {
  /** Env a launch of the harness, and its login command, need for this login. */
  env: Record<string, string>;
  credentialPath: string | null;
  loginCommand: string[] | null;
  /** Lines typed into the login terminal after the command starts. */
  loginInput: string[];
  loginInputDelayMs: number | null;
  instructions: string | null;
}

interface ProviderMatch {
  plugin: ResolvedPlugin;
  provider: ResolvedAccountProvider;
}

/** Answers one account op against the loaded plugins. */
export async function handleAccountsOp(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  request: AccountsOp,
): Promise<unknown> {
  if (request.op === "providers") {
    return listAccountProviders(winningPlugins(plugins, request.root), sdk, request.root);
  }
  const match = findProvider(plugins, request.pluginId, request.providerId, request.root);
  if (request.op === "launch") {
    return accountLaunch(match.provider, request.home);
  }
  if (request.op === "activate") {
    return activateLogin(match, sdk, request.home, request.env ?? {}, request.root);
  }
  const ctx = accountContext(match, sdk, request.home, request.root);
  if (request.op === "identify") {
    return identifyLogin(match.provider, ctx);
  }
  if (request.op === "readToken") {
    return (await sharedTokenOf(match.provider).read(ctx)) ?? null;
  }
  if (request.op === "writeToken") {
    const { write } = sharedTokenOf(match.provider);
    if (!write) throw new Error(`${match.provider.title} cannot take another harness's sign-in`);
    await write(ctx, request.token);
    return { ok: true };
  }
  return loadAccountUsage(match.provider, ctx);
}

/**
 * Flattens every plugin's account providers into wire metadata, leaving out
 * any the installed harness says it no longer offers (`available`).
 */
export async function listAccountProviders(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  root?: string,
): Promise<AccountProviderInfo[]> {
  const listed = await Promise.all(
    plugins.flatMap((plugin) =>
      resolveAccountProviders(plugin.definition).map(async (provider) =>
        (await isAvailable(provider, pluginContext(plugin, sdk, root)))
          ? [providerInfo(plugin, provider)]
          : [],
      ),
    ),
  );
  return listed.flat();
}

/** The harness's own answer, or true when it has none or cannot give one. */
async function isAvailable(
  provider: ResolvedAccountProvider,
  ctx: PluginContext,
): Promise<boolean> {
  if (!provider.available) return true;
  try {
    return await provider.available(ctx);
  } catch {
    return true;
  }
}

/** The env, credential path, and login command for one login home. */
export function accountLaunch(
  provider: ResolvedAccountProvider,
  home: string | null,
): AccountLaunch {
  const env = home !== null && provider.env ? provider.env(home) : {};
  return {
    env,
    credentialPath: provider.credentialPath?.(home) ?? null,
    loginCommand: provider.login?.command ?? null,
    loginInput: provider.login?.input ?? [],
    loginInputDelayMs: provider.login?.inputDelayMs ?? null,
    instructions: provider.login?.instructions ?? null,
  };
}

/** The provider's shared-token callbacks, or an error naming the provider. */
function sharedTokenOf(provider: ResolvedAccountProvider) {
  if (!provider.sharedToken) {
    throw new Error(`${provider.title} cannot share a sign-in`);
  }
  return provider.sharedToken;
}

/** Whether a provider switches accounts by swapping its shared credential file. */
function swaps(provider: ResolvedAccountProvider): boolean {
  return provider.env === undefined && provider.swap !== undefined;
}

/**
 * Swaps the login's credential into the harness's shared file before a
 * launch. A provider without `swap` has nothing to do.
 */
async function activateLogin(
  match: ProviderMatch,
  sdk: PragmaClient,
  home: string | null,
  env: Record<string, string>,
  root: string | undefined,
): Promise<{ ok: true }> {
  const { swap } = match.provider;
  if (swap && swaps(match.provider)) {
    await swap.activate({
      ...pluginContext(match.plugin, withAccountEnv(sdk, env), root),
      account: { loginId: home ?? "default", home, env },
    });
  }
  return { ok: true };
}

/** Runs the plugin's `identify`, validating what it returns. */
async function identifyLogin(
  provider: ResolvedAccountProvider,
  ctx: AccountContext,
): Promise<AccountIdentity | null> {
  if (!provider.identify) return null;
  const identity = await provider.identify(ctx);
  if (identity === null) return null;
  if (!identity || typeof identity.id !== "string" || identity.id.length === 0) {
    throw new Error(`${provider.title} returned an identity without an id`);
  }
  return identity;
}

/** Loads one login's usage, mapping a throw onto an `unavailable` result. */
export async function loadAccountUsage(
  provider: ResolvedAccountProvider,
  ctx: AccountContext,
): Promise<UsageLimitsResult> {
  if (!provider.usageLimits) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: `${provider.title} does not report usage limits.`,
    };
  }
  try {
    return await provider.usageLimits.load(ctx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      reason: "error",
      message: detail || `${provider.title} usage limits could not be loaded.`,
    };
  }
}

/**
 * Wraps an SDK so every `exec.run` carries the login's env. Existing usage
 * loaders (`runProviderCommand`, `ctx.sdk.exec.run`) become account-aware
 * without changes; an explicit env entry from the caller still wins.
 */
export function withAccountEnv(sdk: PragmaClient, env: Record<string, string>): PragmaClient {
  const entries = Object.entries(env);
  if (entries.length === 0) return sdk;
  const exec = {
    run: (payload: Parameters<PragmaClient["exec"]["run"]>[0]) => {
      const explicit = new Set((payload.env ?? []).map(([key]) => key));
      return sdk.exec.run({
        ...payload,
        env: [...entries.filter(([key]) => !explicit.has(key)), ...(payload.env ?? [])],
      });
    },
  };
  return new Proxy(sdk, {
    get: (target, property, receiver) =>
      property === "exec" ? exec : Reflect.get(target, property, receiver),
  });
}

/**
 * One plugin per id: the project-scoped copy for `root` wins over the global
 * one, matching how the catalog picks a winner.
 */
export function winningPlugins(plugins: ResolvedPlugin[], root?: string): ResolvedPlugin[] {
  const byId = new Map<string, ResolvedPlugin>();
  for (const plugin of plugins) {
    if (plugin.scope === "project" && plugin.root !== root) continue;
    if (plugin.scope === "global" && byId.has(plugin.pluginId)) continue;
    byId.set(plugin.pluginId, plugin);
  }
  return [...byId.values()];
}

function findProvider(
  plugins: ResolvedPlugin[],
  pluginId: string,
  providerId: string,
  root: string | undefined,
): ProviderMatch {
  const plugin = winningPlugins(plugins, root).find((candidate) => candidate.pluginId === pluginId);
  const provider = plugin
    ? resolveAccountProviders(plugin.definition).find((candidate) => candidate.id === providerId)
    : undefined;
  if (!plugin || !provider) {
    throw new Error(`account provider not found: ${pluginId}/${providerId}`);
  }
  return { plugin, provider };
}

function accountContext(
  match: ProviderMatch,
  sdk: PragmaClient,
  home: string | null,
  root: string | undefined,
): AccountContext {
  const env = accountLaunch(match.provider, home).env;
  return {
    ...pluginContext(match.plugin, withAccountEnv(sdk, env), root),
    account: { loginId: home ?? "default", home, env },
  };
}

function pluginContext(
  plugin: ResolvedPlugin,
  sdk: PragmaClient,
  root: string | undefined,
): PluginContext {
  return {
    pluginId: plugin.pluginId,
    pluginDir: plugin.dir,
    config: plugin.config,
    project: root ? { id: root, name: root, path: root } : null,
    sdk,
    notify: () => {},
  };
}

function providerInfo(
  plugin: ResolvedPlugin,
  provider: ResolvedAccountProvider,
): AccountProviderInfo {
  return {
    pluginId: plugin.pluginId,
    providerId: provider.id,
    provider: provider.provider,
    title: provider.title,
    agentIds: harnessIds(plugin, provider),
    dashboardUrl: provider.dashboardUrl ?? null,
    iconPath: provider.iconPath ?? null,
    pluginDir: plugin.dir,
    ...loginInfo(provider),
    multiAccount: provider.env !== undefined || provider.swap !== undefined,
    swaps: swaps(provider),
    sharedTokenKind: provider.sharedToken?.kind ?? null,
    sharedTokenWritable: provider.sharedToken?.write !== undefined,
    identifies: provider.identify !== undefined,
    legacy: provider.legacy,
    ...usageInfo(provider),
  };
}

/** Catalog ids of the harnesses a provider serves (see `resolveAccountProviders`). */
function harnessIds(plugin: ResolvedPlugin, provider: ResolvedAccountProvider): string[] {
  return provider.agentIds.map((agentId) => qualifiedAgentId(plugin.pluginId, agentId));
}

function loginInfo(
  provider: ResolvedAccountProvider,
): Pick<AccountProviderInfo, "hasLogin" | "loginInstructions"> {
  return {
    hasLogin: provider.login !== undefined,
    loginInstructions: provider.login?.instructions ?? null,
  };
}

function usageInfo(
  provider: ResolvedAccountProvider,
): Pick<AccountProviderInfo, "primaryLimitId" | "refreshIntervalMs"> {
  const usage = provider.usageLimits;
  return {
    primaryLimitId: usage?.primaryLimitId ?? null,
    refreshIntervalMs: usage?.refreshIntervalMs ?? null,
  };
}
