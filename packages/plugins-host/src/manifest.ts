import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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
 * Mirrors `plugins.rs` `resolve_local_dir` exactly: every local-path specifier
 * resolves against the **directory containing the config file** (`<root>/.pragma`),
 * not the scope root, for the global and project files alike. Non-local
 * specifiers (npm) are skipped here. This is accepted duplication of the Rust
 * resolver, flagged as debt until resolution moves into pragma-core. Unreadable
 * config files and broken entries are skipped, never fatal.
 */
export async function resolveManifests(
  homeDir: string,
  roots: string[],
): Promise<ResolvedManifest[]> {
  const manifests = await Promise.all([
    resolveScope(homeDir, "global", homeDir),
    ...roots.map((root) => resolveScope(root, "project", homeDir)),
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
  homeDir: string,
): Promise<ResolvedManifest[]> {
  const configPath = join(root, CONFIG_FILE);
  // plugins.rs resolves every entry against the config file's own directory
  // (`<root>/.pragma`), not the scope root: `../packages/x` in a project config
  // points at `<project>/packages/x`, and the same holds for `~/.pragma`.
  const configDir = dirname(configPath);
  const entries = await readConfigEntries(configPath);
  const manifests = await Promise.all(
    entries.map((entry) => {
      const dir = resolveLocalDir(configDir, homeDir, entry.path);
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

/**
 * Resolves a local-path plugin specifier exactly as `plugins.rs`
 * `resolve_local_dir` does: `~/` and `~\` against the home directory, absolute
 * paths as given, and explicit relative paths against the directory containing
 * the config file. Anything else is an npm specifier (`null`), which this host
 * skips.
 */
function resolveLocalDir(configDir: string, homeDir: string, specifier: string): string | null {
  if (specifier.startsWith("~/") || specifier.startsWith("~\\")) {
    return homeDir ? resolve(homeDir, specifier.slice(2)) : null;
  }
  if (isAbsolute(specifier)) {
    return resolve(specifier);
  }
  if (isExplicitRelative(specifier)) {
    return resolve(configDir, specifier);
  }
  return null;
}

/**
 * True when a specifier explicitly opts into relative resolution. Mirrors the
 * component check in `plugins.rs`: bare `.` / `..`, `./` / `../`, and the `.\` /
 * `..\` spellings where the platform treats backslash as a separator. A dotfile
 * name such as `.hidden` is not relative and stays an npm specifier.
 */
function isExplicitRelative(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    (sep === "\\" && (specifier.startsWith(".\\") || specifier.startsWith("..\\")))
  );
}
