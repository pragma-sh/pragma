import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { normalizePluginName } from "./names";
import { detectPackageManager, type PackageManager } from "./package-manager";
import { pluginTemplate } from "./templates";

export type ScaffoldCapability = "ui" | "commands" | "agents";

export interface ScaffoldOptions {
  directory: string;
  name?: string;
  packageManager?: PackageManager;
  capabilities?: readonly ScaffoldCapability[];
  force?: boolean;
}

export interface ScaffoldResult {
  directory: string;
  packageName: string;
  packageManager: PackageManager;
  files: string[];
}

/** Creates a new Pragma plugin project from the built-in TypeScript template. */
export async function scaffoldPlugin(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const directory = resolve(options.directory);
  const packageName = normalizePluginName(options.name ?? basename(directory));
  const packageManager = options.packageManager ?? detectPackageManager(process.cwd());
  const capabilities = options.capabilities?.length ? options.capabilities : (["ui"] as const);
  await assertWritableDirectory(directory, options.force === true);
  const files = pluginTemplate({
    packageName,
    displayName: titleCase(packageName),
    directoryName: basename(directory),
    packageManager,
    capabilities,
  });
  for (const file of files) {
    const path = join(directory, file.path);
    // oxlint-disable-next-line no-await-in-loop -- file writes must run in declaration order so partial scaffolds fail-fast and never leave a half-written plugin directory behind.
    await mkdir(join(path, ".."), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await writeFile(path, file.contents);
  }
  return { directory, packageName, packageManager, files: files.map((file) => file.path) };
}

async function assertWritableDirectory(directory: string, force: boolean): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (!force && entries.length > 0) {
      throw new Error(`destination is not empty: ${directory}`);
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw cause;
  }
}

function titleCase(packageName: string): string {
  return packageName
    .split(/[._~-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
