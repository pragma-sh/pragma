#!/usr/bin/env bun
/**
 * Publishes Pragma's public npm packages, in dependency order.
 *
 * Run by the `publish-packages` job in `.github/workflows/release.yml` after
 * Release Please cuts a desktop release. Every package here is in the linked
 * `desktop` version group, so one release moves them all to the same version
 * and `node-workspace` has already rewritten their internal ranges to it.
 *
 * **Dry run is the default.** Publishing is irreversible — npm refuses to
 * unpublish a version after 72 hours and never lets a name be reused — so it
 * happens only with an explicit `--publish`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Publish order is dependency order: a consumer never reaches the registry
 * before the package it declares. npm does not resolve dependencies at publish
 * time, so this is about what a person sees mid-release, not correctness.
 */
const PACKAGES = [
  "constants",
  "sidecar-kit",
  "scratchpad-contract",
  "sdk",
  "plugin",
  "scratchpad",
  "scratchpad-viewer",
  "automations",
  "create-pragma-plugin",
] as const;

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

function manifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
}

/**
 * A folder spec npm cannot mistake for something else.
 *
 * `npm publish packages/sdk` resolves as the GitHub shorthand
 * `github:packages/sdk` and dies in `git ls-remote`; the leading `./` is what
 * makes it a directory.
 */
function folderSpec(directory: string): string {
  return `./${directory}`;
}

/** True when this exact name@version is already on the registry. */
function alreadyPublished(name: string, version: string): boolean {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why one dependency range on a sibling public package is unreleasable, or null.
 *
 * Two ways this goes wrong, both shipping a tarball nobody can install: a
 * `workspace:` protocol range, which **npm does not substitute** at pack or
 * publish time (verified — `npm pack` and `npm pack -w` both emit
 * `"workspace:*"` verbatim), and a stale literal range left behind because
 * Release Please's `node-workspace` plugin did not rewrite it.
 */
function rangeProblem(dependency: string, range: string, version: string): string | null {
  if (range.startsWith("workspace:")) {
    return `${dependency}@${range} — npm never substitutes the workspace protocol`;
  }
  if (range === version || range === `^${version}`) return null;
  return `${dependency}@${range}, but ${dependency} publishes ${version}`;
}

/** Why one `dependencies` entry is unreleasable, or null when it is fine. */
function dependencyProblem(
  pkg: Manifest,
  versions: Map<string, string>,
  [dependency, range]: [string, string],
): string | null {
  const version = versions.get(dependency);
  if (version === undefined) return null;
  const problem = rangeProblem(dependency, range, version);
  return problem === null ? null : `${pkg.name} -> ${problem}`;
}

/** Every unreleasable internal range in one manifest. */
function badInternalRanges(pkg: Manifest, versions: Map<string, string>): string[] {
  return Object.entries(pkg.dependencies ?? {})
    .map((entry) => dependencyProblem(pkg, versions, entry))
    .filter((problem): problem is string => problem !== null);
}

function publish(directory: string, live: boolean): void {
  const args = ["publish", folderSpec(directory), "--access", "public"];
  execFileSync("npm", live ? [...args, "--provenance"] : [...args, "--dry-run"], {
    stdio: "inherit",
  });
}

/**
 * True when this version is already on the registry, so a re-run of a
 * partially-failed job finishes the rest instead of dying on the first one.
 */
function alreadyDone(pkg: Manifest, live: boolean): boolean {
  return live && alreadyPublished(pkg.name, pkg.version);
}

function actionLabel(live: boolean): string {
  return live ? "publish" : "check";
}

/** One package in the release: where it lives and what it declares. */
interface Release {
  directory: string;
  pkg: Manifest;
}

/** Every reason one package must not be released, or an empty list. */
function packageProblems({ pkg }: Release, versions: Map<string, string>): string[] {
  if (pkg.private) return [`${pkg.name} is still marked private`];
  return badInternalRanges(pkg, versions);
}

/** Publishes one package that has already passed validation. */
function releasePackage({ directory, pkg }: Release, live: boolean): void {
  if (alreadyDone(pkg, live)) {
    console.log(`skip ${pkg.name}@${pkg.version} (already on the registry)`);
    return;
  }
  console.log(`${actionLabel(live)} ${pkg.name}@${pkg.version}`);
  publish(directory, live);
}

/** The version each package in this release publishes, keyed by package name. */
function publishedVersions(all: Release[]): Map<string, string> {
  return new Map(all.map(({ pkg }) => [pkg.name, pkg.version] as const));
}

/** Every package in the release, in publish order. */
function releases(): Release[] {
  return PACKAGES.map((name) => {
    const directory = join("packages", name);
    return { directory, pkg: manifest(directory) };
  });
}

/**
 * Validation runs to completion before the first `npm publish`.
 *
 * Publishing is irreversible, so a manifest problem found in the ninth package
 * must not arrive after the first eight tarballs are already on the registry:
 * every manifest is checked, and only an entirely clean release publishes.
 */
function main(): void {
  const live = process.argv.includes("--publish");
  if (!live) console.log("dry run — pass --publish to release for real\n");

  const all = releases();
  const versions = publishedVersions(all);
  const problems = all.flatMap((release) => packageProblems(release, versions));
  if (problems.length > 0) {
    throw new Error(`refusing to release:\n  ${problems.join("\n  ")}`);
  }
  for (const release of all) releasePackage(release, live);
}

if (import.meta.main) main();
