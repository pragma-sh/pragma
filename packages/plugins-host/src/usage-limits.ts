import { isAbsolute, join } from "node:path";

import type { UsageLimit, UsageLimitsProvider, UsageLimitsResult } from "@pragma/constants";
import type { PluginContext, UsageLimitProviderDefinition } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import { hashIcon, type IconAsset, type ResolvedPlugin } from "./catalog";

/** The static half of a provider: everything a client renders before a reading arrives. */
export type UsageLimitsProviderMeta = Omit<
  UsageLimitsProvider,
  "result" | "observedAt" | "loading"
>;

/** One provider's declaration paired with the plugin that contributed it. */
interface ProviderEntry {
  plugin: ResolvedPlugin;
  definition: UsageLimitProviderDefinition;
  meta: UsageLimitsProviderMeta;
}

/**
 * Selects the providers visible in one scope. A `project` plugin answers only
 * for the project that contributed it — sharing providers across roots is how
 * one project's `.pragma/config.json` would end up reporting another's usage.
 */
export function visibleProviders(plugins: ResolvedPlugin[], root?: string): ResolvedPlugin[] {
  return plugins.filter((plugin) => plugin.scope !== "project" || !root || plugin.root === root);
}

/**
 * Collects provider metadata and registers each declared icon in the shared
 * asset map, so a provider icon is fetched by content hash through the same
 * `/v1/assets/{hash}` route as an agent icon. A provider whose icon file is
 * missing or oversized keeps its metadata and loses only the icon: a broken
 * asset must not hide the provider's usage.
 */
export function assembleUsageProviders(
  plugins: ResolvedPlugin[],
  assets: Record<string, IconAsset>,
  onError: (pluginId: string, providerId: string, error: unknown) => void = () => {},
): UsageLimitsProviderMeta[] {
  return providerEntries(plugins, assets, onError).map((entry) => entry.meta);
}

/**
 * Loads every visible provider's usage and validates the result against its
 * declaration. Providers load concurrently and fail independently: one
 * provider throwing becomes an `unavailable` reading for that provider alone.
 */
export async function loadUsageLimits(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  root: string | undefined,
  options: {
    pluginId?: string;
    providerId?: string;
    /**
     * Metadata already resolved at catalog time. Reusing it keeps a reading
     * from re-hashing icon files, and keeps the icon a client sees identical to
     * the one the asset map actually holds.
     */
    known?: readonly UsageLimitsProviderMeta[];
  } = {},
): Promise<UsageLimitsProvider[]> {
  const entries = providerEntries(
    visibleProviders(plugins, root),
    {},
    () => {},
    options.known,
  ).filter(
    (entry) =>
      (!options.pluginId || entry.plugin.pluginId === options.pluginId) &&
      (!options.providerId || entry.definition.id === options.providerId),
  );
  const settled = await Promise.allSettled(
    entries.map(async (entry) =>
      validateResult(
        entry.definition,
        await entry.definition.load(contextFor(entry.plugin, sdk, root)),
      ),
    ),
  );
  const providers: UsageLimitsProvider[] = [];
  for (const [index, entry] of entries.entries()) {
    const outcome = settled[index];
    const result =
      outcome?.status === "fulfilled"
        ? outcome.value
        : unavailableResult(entry.meta.title, outcome?.reason);
    providers.push(Object.assign({}, entry.meta, { result }));
  }
  return providers;
}

function providerEntries(
  plugins: ResolvedPlugin[],
  assets: Record<string, IconAsset>,
  onError: (pluginId: string, providerId: string, error: unknown) => void = () => {},
  known?: readonly UsageLimitsProviderMeta[],
): ProviderEntry[] {
  const byKey = new Map(known?.map((meta) => [`${meta.pluginId}\u0000${meta.providerId}`, meta]));
  return plugins.flatMap((plugin) =>
    (plugin.definition.usageLimits ?? []).map((definition) => ({
      plugin,
      definition,
      meta: byKey.get(`${plugin.pluginId}\u0000${definition.id}`) ?? {
        pluginId: plugin.pluginId,
        providerId: definition.id,
        title: definition.title,
        dashboardUrl: definition.dashboardUrl,
        primaryLimitId: definition.primaryLimitId,
        ...(definition.refreshIntervalMs === undefined
          ? {}
          : { refreshIntervalMs: definition.refreshIntervalMs }),
        ...iconRef(plugin, definition, assets, onError),
      },
    })),
  );
}

/**
 * Hashes a provider's declared icon file into the asset map. A component icon
 * (`definition.icon`) is a desktop-only React element and has no wire form, so
 * it is deliberately not represented here.
 */
function iconRef(
  plugin: ResolvedPlugin,
  definition: UsageLimitProviderDefinition,
  assets: Record<string, IconAsset>,
  onError: (pluginId: string, providerId: string, error: unknown) => void,
): Pick<UsageLimitsProviderMeta, "icon"> {
  if (!definition.iconPath || /^https?:\/\//.test(definition.iconPath)) {
    return {};
  }
  // Declarations are plugin-directory-relative so one bundle works from any
  // install location; absolute paths pass through.
  const path = isAbsolute(definition.iconPath)
    ? definition.iconPath
    : join(plugin.dir, definition.iconPath);
  try {
    const asset = hashIcon(path);
    assets[asset.hash] = asset;
    return { icon: { hash: asset.hash, mime: asset.mime } };
  } catch (error) {
    onError(plugin.pluginId, definition.id, error);
    return {};
  }
}

/**
 * Rejects a reading that would render as a misleading card: an unparseable
 * observation time, a duplicate or malformed category, or a missing primary
 * limit. Validation lives here, on the host, so every client renders the same
 * checked data instead of repeating these rules.
 */
export function validateResult(
  definition: Pick<UsageLimitProviderDefinition, "title" | "primaryLimitId">,
  result: UsageLimitsResult,
): UsageLimitsResult {
  if (result.status === "unavailable") {
    return result;
  }
  if (!Number.isFinite(result.observedAt)) {
    throw new Error(`${definition.title} returned an invalid observation time`);
  }
  const ids = collectValidLimitIds(definition, result.limits);
  if (result.summary !== undefined && !isValidUsageLimit(result.summary)) {
    throw new Error(`${definition.title} returned an invalid summary limit`);
  }
  const summaryIsPrimary = result.summary?.id === definition.primaryLimitId;
  if (!ids.has(definition.primaryLimitId) && !summaryIsPrimary) {
    throw new Error(
      `${definition.title} did not return primary limit "${definition.primaryLimitId}"`,
    );
  }
  return result;
}

function collectValidLimitIds(
  definition: Pick<UsageLimitProviderDefinition, "title">,
  limits: readonly UsageLimit[],
): Set<string> {
  const ids = new Set<string>();
  for (const limit of limits) {
    if (ids.has(limit.id) || !isValidUsageLimit(limit)) {
      throw new Error(`${definition.title} returned an invalid usage limit`);
    }
    ids.add(limit.id);
  }
  return ids;
}

function isValidUsageLimit(limit: UsageLimit): boolean {
  return (
    Boolean(limit.id) &&
    Boolean(limit.title) &&
    Number.isFinite(limit.used) &&
    limit.used >= 0 &&
    (limit.limit === null || (Number.isFinite(limit.limit) && limit.limit > 0)) &&
    (limit.resetsInMs === undefined || (Number.isFinite(limit.resetsInMs) && limit.resetsInMs >= 0))
  );
}

function unavailableResult(title: string, reason: unknown): UsageLimitsResult {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return {
    status: "unavailable",
    reason: "error",
    message: detail || `${title} usage limits could not be loaded.`,
  };
}

function contextFor(
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
