import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** One resolved plugin manifest: where to import it from and under what id. */
export interface ResolvedManifest {
  pluginId: string;
  mainPath: string;
  config: unknown;
  scope: "global" | "project";
  root: string;
}

interface ConfigEntry {
  path: string;
  config?: unknown;
}

interface PragmaConfigFile {
  plugins?: ConfigEntry[];
}

interface PackageJson {
  name?: string;
  main?: string;
}

const CONFIG_FILE = ".pragma/config.json";

/**
 * Resolves plugin manifests declared in the global `~/.pragma/config.json` and
 * each project root's `.pragma/config.json`, preserving declaration order.
 *
 * Mirrors `plugins.rs` `resolve_local_dir` semantics for local-path specifiers
 * (`./`, `../`, `/`, `~/`); non-local specifiers (npm) are skipped here. This is
 * accepted duplication of the Rust resolver, flagged as debt until resolution
 * moves into pragma-core. Unreadable config files and broken entries are
 * skipped, never fatal.
 */
export async function resolveManifests(
  homeDir: string,
  roots: string[],
): Promise<ResolvedManifest[]> {
  const manifests: ResolvedManifest[] = [];
  manifests.push(...(await resolveScope(homeDir, "global")));
  for (const root of roots) {
    manifests.push(...(await resolveScope(root, "project")));
  }
  return manifests;
}

async function resolveScope(
  root: string,
  scope: "global" | "project",
): Promise<ResolvedManifest[]> {
  const entries = await readConfigEntries(join(root, CONFIG_FILE));
  const resolved: ResolvedManifest[] = [];
  for (const entry of entries) {
    const manifest = await resolveEntry(root, entry, scope);
    if (manifest) {
      resolved.push(manifest);
    }
  }
  return resolved;
}

async function readConfigEntries(configPath: string): Promise<ConfigEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as PragmaConfigFile;
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

async function resolveEntry(
  root: string,
  entry: ConfigEntry,
  scope: "global" | "project",
): Promise<ResolvedManifest | null> {
  const dir = resolveLocalDir(root, entry.path);
  if (!dir) {
    return null;
  }
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
    if (!pkg.name || !pkg.main) {
      return null;
    }
    return {
      pluginId: pkg.name,
      mainPath: resolve(dir, pkg.main),
      config: entry.config,
      scope,
      root,
    };
  } catch {
    return null;
  }
}

/** Resolves a local-path plugin specifier to an absolute directory, or null. */
function resolveLocalDir(root: string, specifier: string): string | null {
  if (specifier.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home ? join(home, specifier.slice(2)) : null;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolve(root, specifier);
  }
  if (isAbsolute(specifier)) {
    return specifier;
  }
  return null;
}
