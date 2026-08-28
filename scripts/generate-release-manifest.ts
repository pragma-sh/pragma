/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface ReleaseAsset {
  url: string;
  sha256: string;
  signature: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  releasedAt: string;
  gitSha: string;
  apply: "reload" | "restart";
  notes: string;
  changelogUrl: string;
  components: Record<string, string>;
  assets: Record<string, ReleaseAsset>;
}

interface NativeComponents {
  app: string;
  server: string;
  protocol: string;
}

const PLATFORM_BY_MARKER: Record<string, string> = {
  "darwin-aarch64": "darwin-aarch64",
  "darwin-x86_64": "darwin-x86_64",
  "linux-aarch64-deb": "linux-aarch64-deb",
  "linux-aarch64-rpm": "linux-aarch64-rpm",
  "linux-x86_64-deb": "linux-x86_64-deb",
  "linux-x86_64-rpm": "linux-x86_64-rpm",
  "windows-x86_64": "windows-x86_64",
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cargoVersion(path: string): string {
  return cargoVersionFromText(readFileSync(path, "utf8"), path);
}

function cargoVersionFromText(contents: string, path: string): string {
  const match = contents.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) throw new Error(`version missing from ${path}`);
  return match[1];
}

function fileAtTag(tag: string, path: string): string {
  return execFileSync("git", ["show", `${tag}:${path}`], { encoding: "utf8" });
}

/** Returns reload only when every substantive change belongs to desktop React UI. */
function releaseApplyMode(previousTag: string | undefined): "reload" | "restart" {
  if (!previousTag) return "restart";
  return applyModeForPaths(substantivePaths(`${previousTag}..HEAD`));
}

/** Classifies paths from non-release commits in the desktop release range. */
export function applyModeForPaths(paths: string[]): "reload" | "restart" {
  return paths.length > 0 && paths.every((path) => path.startsWith("apps/pragma/src/"))
    ? "reload"
    : "restart";
}

function substantivePaths(range: string): string[] {
  const paths = new Set<string>();
  const commits = execFileSync("git", ["rev-list", "--reverse", range], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const subject = execFileSync("git", ["show", "-s", "--format=%s", commit], {
      encoding: "utf8",
    }).trim();
    if (/^chore(?:\([^)]*\))?: release\b/.test(subject)) continue;
    const changed = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", commit],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    for (const path of changed) paths.add(path);
  }
  return [...paths];
}

function nativeBaseTag(previousTag: string): string {
  const tags = execFileSync(
    "git",
    ["tag", "--merged", "HEAD", "--list", "pragma-v*", "--sort=-version:refname"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const start = requiredTagIndex(tags, previousTag);
  for (const [index, tag] of tags.slice(start).entries()) {
    const prior = tags[start + index + 1];
    if (!prior) return tag;
    if (applyModeForPaths(substantivePaths(`${prior}..${tag}`)) === "restart") return tag;
  }
  return previousTag;
}

function requiredTagIndex(tags: string[], tag: string): number {
  const index = tags.indexOf(tag);
  if (index === -1) throw new Error(`previous desktop tag not found: ${tag}`);
  return index;
}

function assetKey(fileName: string): string | undefined {
  if (fileName.includes("-ui.tar")) return "ui";
  return Object.entries(PLATFORM_BY_MARKER).find(([marker]) => fileName.includes(marker))?.[1];
}

function releaseAssets(directory: string, downloadBaseUrl: string): Record<string, ReleaseAsset> {
  const assets: Record<string, ReleaseAsset> = {};
  for (const fileName of readdirSync(directory)) {
    if (fileName.endsWith(".sig")) continue;
    const key = assetKey(fileName);
    if (!key) continue;
    const path = join(directory, fileName);
    const signaturePath = `${path}.sig`;
    assets[key] = {
      url: `${downloadBaseUrl}/${encodeURIComponent(basename(path))}`,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      signature: assetSignature(signaturePath),
    };
  }
  return assets;
}

function assetSignature(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function currentNativeComponents(appVersion: string): NativeComponents {
  return {
    app: appVersion,
    server: cargoVersion("crates/pragma-server/Cargo.toml"),
    protocol: cargoVersion("crates/pragma-protocol/Cargo.toml"),
  };
}

function nativeComponentsAtTag(tag: string): NativeComponents {
  return {
    app: (
      JSON.parse(fileAtTag(tag, "packages/constants/values.json")) as {
        app: { version: string };
      }
    ).app.version,
    server: cargoVersionFromText(
      fileAtTag(tag, "crates/pragma-server/Cargo.toml"),
      "crates/pragma-server/Cargo.toml",
    ),
    protocol: cargoVersionFromText(
      fileAtTag(tag, "crates/pragma-protocol/Cargo.toml"),
      "crates/pragma-protocol/Cargo.toml",
    ),
  };
}

function releaseNativeComponents(
  appVersion: string,
  apply: "reload" | "restart",
  previousTag: string | undefined,
): NativeComponents {
  if (apply !== "reload" || !previousTag) return currentNativeComponents(appVersion);
  return nativeComponentsAtTag(nativeBaseTag(previousTag));
}

function requiredAssetKeys(apply: "reload" | "restart"): string[] {
  return apply === "reload"
    ? ["ui"]
    : [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64-deb",
        "linux-aarch64-rpm",
        "linux-x86_64-deb",
        "linux-x86_64-rpm",
        "windows-x86_64",
      ];
}

function validateAssets(manifest: ReleaseManifest): void {
  for (const key of requiredAssetKeys(manifest.apply)) {
    const asset = manifest.assets[key];
    if (!asset) throw new Error(`release is ${manifest.apply} but ${key} asset is missing`);
    if (!asset.signature) throw new Error(`${key} asset is unsigned`);
  }
}

function main(): void {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const tag = requiredEnv("RELEASE_TAG");
  const gitSha = requiredEnv("RELEASE_SHA");
  const assetsDir = requiredEnv("RELEASE_ASSETS_DIR");
  const output = process.env.RELEASE_MANIFEST_PATH ?? join(assetsDir, "release.json");
  const app = JSON.parse(readFileSync("packages/constants/values.json", "utf8")) as {
    app: { version: string };
  };
  const apply = releaseApplyMode(process.env.PREVIOUS_RELEASE_TAG?.trim() || undefined);
  const previousTag = process.env.PREVIOUS_RELEASE_TAG?.trim();
  const nativeComponents = releaseNativeComponents(app.app.version, apply, previousTag);
  const downloadBaseUrl = `https://github.com/${repository}/releases/download/${tag}`;
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    releasedAt: new Date().toISOString(),
    gitSha,
    apply,
    notes: process.env.RELEASE_NOTES ?? "",
    changelogUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    components: {
      ui: app.app.version,
      app: nativeComponents.app,
      "pragma-server": nativeComponents.server,
      "pragma-protocol": nativeComponents.protocol,
    },
    assets: releaseAssets(assetsDir, downloadBaseUrl),
  };
  validateAssets(manifest);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release manifest: ${apply} -> ${output}`);
}

if (import.meta.main) main();
