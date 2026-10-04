import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  packageRoot,
  readJson,
  registryTarball,
  validateManifest,
  workspaceSource,
  type LockEntry,
  type PluginManifest,
} from "./shared";

interface OfficialFile {
  schemaVersion: 1;
  packages: string[];
}

interface PackResult {
  integrity: string;
  filename: string;
  version: string;
}

/**
 * `npm pack --json` prints an array up to npm 11 and, from npm 12, an object keyed by
 * package name. Either way this lock packs exactly one package per call.
 */
function firstPackResult(
  output: PackResult[] | Record<string, PackResult>,
): PackResult | undefined {
  return Array.isArray(output) ? output[0] : Object.values(output)[0];
}

const local = process.argv.includes("--local");
/**
 * Without an explicit dist-tag, each plugin resolves to the exact version its workspace
 * `package.json` declares — on `main` after a release, the version just published. A
 * dist-tag would be read from npm's cached package metadata, which can still name the
 * previous release minutes after a publish.
 */
const distTag = process.env.PRAGMA_PLUGIN_DIST_TAG;
/** How long to wait for npm's metadata to list a version that was just published. */
const PACK_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

/** Packs `specifier` into `destination`, retrying while npm does not yet list the version. */
function pack(specifier: string, destination: string): PackResult | undefined {
  for (let attempt = 0; ; attempt += 1) {
    const packed = Bun.spawnSync(
      ["npm", "pack", specifier, "--json", "--ignore-scripts", "--pack-destination", destination],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );
    if (packed.exitCode === 0) return firstPackResult(JSON.parse(packed.stdout.toString()));
    const stderr = packed.stderr.toString();
    const delay = PACK_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !/ETARGET|E404|No matching version/.test(stderr)) {
      throw new Error(`${specifier}: npm pack failed: ${stderr}`);
    }
    console.warn(`${specifier}: not on npm yet, retrying in ${delay / 1000}s`);
    Bun.sleepSync(delay);
  }
}
const official = await readJson<OfficialFile>(join(packageRoot, "official.json"));
const temp = await mkdtemp(join(tmpdir(), "pragma-plugin-lock-"));

try {
  const plugins: LockEntry[] = [];
  for (const packageName of official.packages) {
    const source = workspaceSource(packageName);
    if (local) {
      const build = Bun.spawnSync(["bun", "run", "build"], {
        cwd: source,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (build.exitCode !== 0) throw new Error(`${packageName}: build failed`);
    }
    const version =
      distTag ??
      (JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string })
        .version;
    const result = pack(local ? source : `${packageName}@${version}`, temp);
    if (!result?.integrity || !result.filename || !result.version)
      throw new Error(`${packageName}: npm pack returned incomplete metadata`);

    const manifestText = extractManifest(join(temp, result.filename));
    const manifest = JSON.parse(manifestText) as PluginManifest;
    validateManifest(manifest, packageName);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(manifestText);
    plugins.push({
      package: packageName,
      version: result.version,
      tarball: registryTarball(packageName, result.version),
      integrity: result.integrity,
      manifestSha256: hasher.digest("hex"),
      manifest,
    });
  }

  const output = `${JSON.stringify({ $schema: "./lock.schema.json", schemaVersion: 1, plugins }, null, 2)}\n`;
  const outputPath = join(packageRoot, "official.lock.json");
  await Bun.write(outputPath, output);
  const formatted = Bun.spawnSync(["bunx", "oxfmt", outputPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (formatted.exitCode !== 0) throw new Error("failed to format official plugin lock");
} finally {
  await rm(temp, { recursive: true, force: true });
}

function extractManifest(tarball: string): string {
  const result = Bun.spawnSync(["tar", "-xOf", tarball, "package/pragma-plugin.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`published package lacks pragma-plugin.json: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
