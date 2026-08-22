import { officialPluginLock, type LockedPlugin } from "@pragma/plugin-registry";

import { installOfficialPlugin } from "@/lib/tauri";

const OFFICIAL_LOCK_URL =
  "https://raw.githubusercontent.com/pragma-sh/pragma/main/packages/plugin-registry/official.lock.json";

interface PluginLock {
  schemaVersion: 1;
  plugins: LockedPlugin[];
}

let cachedLock: Promise<LockedPlugin[]> | null = null;

/** Returns reviewed release metadata bundled with this app, without network I/O. */
export function bundledOfficialPluginLock(): LockedPlugin[] {
  return validateLock(officialPluginLock);
}

/** Loads official GitHub lock once, with checked-in release metadata as offline fallback. */
export function loadOfficialPluginLock(): Promise<LockedPlugin[]> {
  cachedLock ??= fetch(OFFICIAL_LOCK_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`official plugin lock returned ${response.status}`);
      return validateLock((await response.json()) as PluginLock);
    })
    .catch(() => bundledOfficialPluginLock());
  return cachedLock;
}

/** Installs exact release represented by one validated lock entry. */
export async function installLockedPlugin(plugin: LockedPlugin): Promise<void> {
  await installOfficialPlugin({
    package: plugin.package,
    version: plugin.version,
    integrity: plugin.integrity,
    manifestSha256: plugin.manifestSha256,
  });
  window.dispatchEvent(new Event("pragma:config-changed"));
}

/** Human-readable install command shown before native execution. */
export function displayInstallCommand(plugin: LockedPlugin): string {
  return [plugin.manifest.install.command, ...(plugin.manifest.install.args ?? [])]
    .map(quoteArgument)
    .join(" ");
}

function quoteArgument(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function validateLock(lock: PluginLock): LockedPlugin[] {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.plugins)) {
    throw new Error("unsupported official plugin lock");
  }
  const packages = new Set<string>();
  return lock.plugins.filter((plugin) => {
    if (
      packages.has(plugin.package) ||
      !plugin.integrity.startsWith("sha512-") ||
      !/^[a-f0-9]{64}$/.test(plugin.manifestSha256) ||
      !plugin.manifest.install?.command
    ) {
      return false;
    }
    packages.add(plugin.package);
    return true;
  });
}
