import {
  officialPluginLock,
  type LockedPlugin,
  type PragmaPluginManifest,
} from "@pragma/plugin-registry";

import { webDeepLinkUrl } from "@/lib/deep-link";
import { pluginsRoute } from "@/lib/shared";

const OFFICIAL_LOCK_URL =
  "https://raw.githubusercontent.com/pragma-sh/pragma/main/packages/plugin-registry/official.lock.json";

interface PluginLock {
  schemaVersion: 1;
  plugins: LockedPlugin[];
}

/** Loads reviewed plugin metadata from GitHub, falling back to build's checked-in lock. */
export async function loadOfficialPlugins(): Promise<LockedPlugin[]> {
  try {
    const response = await fetch(OFFICIAL_LOCK_URL, { next: { revalidate: 3600 } });
    if (!response.ok) throw new Error(`official plugin lock returned ${response.status}`);
    return validateLock((await response.json()) as PluginLock);
  } catch {
    return validateLock(officialPluginLock);
  }
}

/** Gallery detail route for one official plugin, keyed by npm package identity. */
export function pluginDetailUrl(packageName: string): string {
  return `${pluginsRoute}/${packageName}`;
}

/**
 * Link used by gallery install buttons. Points at the same-origin deep-link
 * forwarder (`/install-plugin?...`) rather than a raw `pragma://` href, so a
 * browser that suppresses custom schemes still lands on an explainer page.
 */
export function pluginInstallUrl(packageName: string): string {
  return webDeepLinkUrl("install-plugin", { package: packageName });
}

/** The npm package page for one official plugin — every official entry is an npm release. */
export function pluginNpmUrl(packageName: string): string {
  return `https://www.npmjs.com/package/${packageName}`;
}

function validateLock(lock: PluginLock): LockedPlugin[] {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.plugins)) {
    throw new Error("unsupported official plugin lock");
  }
  const packages = new Set<string>();
  return lock.plugins.map((plugin) => {
    if (packages.has(plugin.package))
      throw new Error(`duplicate official plugin ${plugin.package}`);
    packages.add(plugin.package);
    validateManifest(plugin.manifest, plugin.package);
    return plugin;
  });
}

function validateManifest(manifest: PragmaPluginManifest, packageName: string): void {
  if (![manifest.name, manifest.description, manifest.install?.command].every(hasText)) {
    throw new Error(`${packageName} has incomplete plugin metadata`);
  }
}

function hasText(value: string | undefined): boolean {
  return Boolean(value);
}
