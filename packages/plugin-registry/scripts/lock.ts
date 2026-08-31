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

const local = process.argv.includes("--local");
const distTag = process.env.PRAGMA_PLUGIN_DIST_TAG ?? "alpha";
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
    const specifier = local ? source : `${packageName}@${distTag}`;
    const packed = Bun.spawnSync(
      ["npm", "pack", specifier, "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );
    if (packed.exitCode !== 0)
      throw new Error(`${packageName}: npm pack failed: ${packed.stderr.toString()}`);
    const result = (JSON.parse(packed.stdout.toString()) as PackResult[])[0];
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
