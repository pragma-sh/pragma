import {
  officialPluginLock,
  type LockedPlugin,
  type PragmaPluginManifest,
} from "@pragma/plugin-registry";

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

/** Deep link opened by gallery install buttons. */
export function pluginInstallUrl(packageName: string): string {
  return `pragma://install-plugin?package=${encodeURIComponent(packageName)}`;
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
  if (!manifest.name || !manifest.description || !manifest.install?.command) {
    throw new Error(`${packageName} has incomplete plugin metadata`);
  }
}
