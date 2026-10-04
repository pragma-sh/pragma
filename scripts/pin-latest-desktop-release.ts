#!/usr/bin/env bun
/**
 * Marks the newest installable desktop release as the repository's "Latest".
 *
 * Release Please publishes a GitHub release for every component in one run —
 * the desktop app, but also each agent plugin and `dev-test-plugin` — and each
 * takes GitHub's default `make_latest`, so whichever lands last wins the flag.
 * That flag is what `/releases/latest` resolves to, and the website's Download
 * button links there: left alone, it sends people to a plugin release.
 *
 * "Installable" means the release carries the signed manifest: a desktop tag
 * whose `publish-desktop` job failed has no installers, and must never be the
 * one a download link points at.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Desktop release tags, as `publish-desktop` and the manifest generator read them. */
const DESKTOP_TAG_PREFIX = "pragma-v";

/** The fields of a GitHub release this script reads. */
export interface ReleaseSummary {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: string[];
}

/**
 * The newest published desktop release that ships `manifestFile`, or null.
 *
 * Ordered by version, not by creation time, so a re-run that republishes an
 * older tag cannot demote a newer one.
 */
export function newestInstallableDesktopRelease(
  releases: ReleaseSummary[],
  manifestFile: string,
): string | null {
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .filter((release) => release.tag_name.startsWith(DESKTOP_TAG_PREFIX))
    .filter((release) => release.assets.includes(manifestFile))
    .map((release) => release.tag_name);
  candidates.sort((a, b) =>
    Bun.semver.order(b.slice(DESKTOP_TAG_PREFIX.length), a.slice(DESKTOP_TAG_PREFIX.length)),
  );
  return candidates[0] ?? null;
}

function fetchReleases(repo: string): ReleaseSummary[] {
  const lines = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repo}/releases?per_page=100`,
      "--jq",
      ".[] | {tag_name, draft, prerelease, assets: [.assets[].name]}",
    ],
    { encoding: "utf8" },
  );
  return lines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReleaseSummary);
}

function main(): void {
  const repo = process.env.GH_REPO;
  if (!repo) throw new Error("GH_REPO must name the repository, e.g. pragma-sh/pragma");
  const values = JSON.parse(readFileSync("packages/constants/values.json", "utf8")) as {
    updates: { manifestFile: string };
  };
  const tag = newestInstallableDesktopRelease(fetchReleases(repo), values.updates.manifestFile);
  if (tag === null) {
    console.log("no installable desktop release yet; leaving Latest unchanged");
    return;
  }
  execFileSync("gh", ["release", "edit", tag, "--repo", repo, "--latest"], { stdio: "inherit" });
  console.log(`marked ${tag} as Latest`);
}

if (import.meta.main) main();
