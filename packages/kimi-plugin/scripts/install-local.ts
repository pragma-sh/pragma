import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface InstalledPlugin extends Record<string, unknown> {
  id: string;
  root: string;
  source: "local-path";
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  originalSource: string;
}

interface InstalledFile {
  version: 1;
  plugins: InstalledPlugin[];
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_PATHS = ["assets", "dist", "hooks", "kimi.plugin.json", "package.json"];

/** Installs a fresh package snapshot into Kimi's managed plugin store. */
export function installLocal(
  kimiHome = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"),
  packageRoot = PACKAGE_ROOT,
): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "kimi.plugin.json"), "utf8")) as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error('kimi.plugin.json must contain a non-empty "name"');
  }
  for (const relativePath of RUNTIME_PATHS) {
    if (!existsSync(join(packageRoot, relativePath))) {
      throw new Error(`Missing runtime path: ${relativePath}`);
    }
  }

  const id = manifest.name.toLowerCase();
  const pluginsDir = join(kimiHome, "plugins");
  const managedDir = join(pluginsDir, "managed");
  const target = join(managedDir, id);
  mkdirSync(managedDir, { recursive: true });
  const staging = mkdtempSync(join(managedDir, `${id}-`));
  try {
    for (const relativePath of RUNTIME_PATHS) {
      cpSync(join(packageRoot, relativePath), join(staging, relativePath), { recursive: true });
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const installedPath = join(pluginsDir, "installed.json");
  const installed = readInstalled(installedPath);
  const existingIndex = installed.plugins.findIndex((plugin) => plugin.id === id);
  const existing = existingIndex < 0 ? undefined : installed.plugins[existingIndex];
  const now = new Date().toISOString();
  const record: InstalledPlugin = {
    ...existing,
    id,
    root: target,
    source: "local-path",
    enabled: existing?.enabled ?? true,
    installedAt:
      typeof existing?.installedAt === "string" && existing.installedAt.length > 0
        ? existing.installedAt
        : now,
    updatedAt: now,
    originalSource: packageRoot,
  };
  if (existingIndex < 0) installed.plugins.push(record);
  else installed.plugins[existingIndex] = record;

  const tempPath = `${installedPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(installed, null, 2)}\n`);
  renameSync(tempPath, installedPath);
  return target;
}

function readInstalled(path: string): InstalledFile {
  if (!existsSync(path)) return { version: 1, plugins: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    version?: unknown;
    plugins?: unknown;
  };
  if (value.version !== 1 || !Array.isArray(value.plugins)) {
    throw new Error(`${path} is not a valid Kimi installed.json file`);
  }
  return { version: 1, plugins: value.plugins as InstalledPlugin[] };
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  const target = installLocal();
  process.stdout.write(`Installed Pragma Kimi plugin to ${target}.\n`);
  process.stdout.write("Run `/plugins reload` or start a new Kimi session to load it.\n");
}
