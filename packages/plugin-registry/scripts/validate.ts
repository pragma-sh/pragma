import { join } from "node:path";

import { packageRoot, readJson, validateManifest, workspaceSource, type LockEntry } from "./shared";

interface OfficialFile {
  schemaVersion: number;
  packages: string[];
}

interface LockFile {
  schemaVersion: number;
  plugins: LockEntry[];
}

const official = await readJson<OfficialFile>(join(packageRoot, "official.json"));
const lock = await readJson<LockFile>(join(packageRoot, "official.lock.json"));

if (official.schemaVersion !== 1 || lock.schemaVersion !== 1) {
  throw new Error("unsupported plugin registry schema version");
}

const packageNames = new Set<string>();
await Promise.all(
  official.packages.map(async (packageName) => {
    if (packageNames.has(packageName)) throw new Error(`duplicate package: ${packageName}`);
    packageNames.add(packageName);
    const source = workspaceSource(packageName);
    const pkg = await readJson<{ name?: string; version?: string; pragma?: { main?: string } }>(
      join(source, "package.json"),
    );
    if (pkg.name !== packageName) {
      throw new Error(`${packageName}: source package identity does not match official list`);
    }
    if (!pkg.pragma?.main) throw new Error(`${packageName}: package.json is missing pragma.main`);
    validateManifest(await readJson(join(source, "pragma-plugin.json")), packageName);
  }),
);

if (lock.plugins.length !== official.packages.length) {
  throw new Error("official lock does not cover official package list");
}
for (const plugin of lock.plugins) {
  if (!official.packages.includes(plugin.package))
    throw new Error(`${plugin.package}: stale lock entry`);
  if (!plugin.integrity.startsWith("sha512-") || !/^[a-f0-9]{64}$/.test(plugin.manifestSha256)) {
    throw new Error(`${plugin.package}: invalid integrity metadata`);
  }
  validateManifest(plugin.manifest, plugin.package);
}
