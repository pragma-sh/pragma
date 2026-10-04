import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** One resolved plugin manifest: where to import it from and under what id. */
export interface ResolvedManifest {
  pluginId: string;
  dir: string;
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
  pragma?: {
    pluginId?: string;
    main?: string;
  };
}

const CONFIG_FILE = ".pragma/config.json";

/**
 * Resolves configured plugin manifests, preserving declaration order: global
 * `~/.pragma/config.json`, then each project root's `.pragma/config.json`.
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
  const manifests = await Promise.all([
    resolveScope(homeDir, "global"),
    ...roots.map((root) => resolveScope(root, "project")),
  ]);
  return preferHigherScope(manifests.flat());
}

function preferHigherScope(manifests: ResolvedManifest[]): ResolvedManifest[] {
  const winningIndex = new Map<string, number>();
  manifests.forEach((manifest, index) => winningIndex.set(manifest.pluginId, index));
  return manifests.filter((manifest, index) => winningIndex.get(manifest.pluginId) === index);
}

async function resolveScope(
  root: string,
  scope: "global" | "project",
): Promise<ResolvedManifest[]> {
  const entries = await readConfigEntries(join(root, CONFIG_FILE));
  const manifests = await Promise.all(
    entries.map((entry) => {
      const dir = resolveLocalDir(root, entry.path);
      return dir ? readManifest(dir, entry.config, scope, root) : null;
    }),
  );
  return manifests.filter((manifest): manifest is ResolvedManifest => manifest !== null);
}

async function readConfigEntries(configPath: string): Promise<ConfigEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as PragmaConfigFile;
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

/**
 * Reads one plugin directory's `package.json` into a manifest. The optional
 * `pragma` field lets a package expose a Pragma plugin entry distinct from its
 * npm identity: `pragma.pluginId` overrides `name` as the stable catalog id,
 * `pragma.main` overrides `main` as the bundle the hosts import.
 */
async function readManifest(
  dir: string,
  config: unknown,
  scope: ResolvedManifest["scope"],
  root: string,
): Promise<ResolvedManifest | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PackageJson;
    const pluginId = pkg.pragma?.pluginId ?? pkg.name;
    const main = pkg.pragma?.main ?? pkg.main;
    if (!pluginId || !main) {
      return null;
    }
    return {
      pluginId,
      dir,
      mainPath: resolve(dir, main),
      config,
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
