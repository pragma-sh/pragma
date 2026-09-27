#!/usr/bin/env bun
/**
 * Decides, per platform, how a Pragma Go release reaches users: an over-the-air
 * update, or a new binary.
 *
 * Pragma Go's `runtimeVersion.policy` is `fingerprint`, so an update is only ever
 * served to a binary whose native fingerprint matches the one the update was
 * published under. That makes the choice mechanical rather than a judgment call:
 * if a finished EAS build of the release profile already carries the checkout's
 * fingerprint, the change is JavaScript-only and ships as an update; otherwise
 * something native moved and a new binary has to be built.
 *
 * Run from `release.yml` on a `pragma-go-v*` release (to act on the plan) and
 * from `pragma-go-ship-plan.yml` on a release PR (to show it before merge).
 * Needs `eas` on `PATH` and an `EXPO_TOKEN`.
 *
 *   bun scripts/pragma-go-ship-plan.ts [--comment <file>]
 *
 * With `GITHUB_OUTPUT` set, writes `<platform>-action`, `-fingerprint`,
 * `-channel`, `-build-id` and `-artifact-url` for the jobs downstream.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "pragma-go");

/** Marker that lets the release-PR comment be updated in place instead of re-posted. */
export const COMMENT_MARKER = "<!-- pragma-go-ship-plan -->";

/**
 * The EAS build profile each platform ships from on release. iOS goes to
 * TestFlight from `production`; Android is the `preview` APK on GitHub (see
 * `release.yml`). Keep in step with the `--profile` in those jobs.
 */
const RELEASE_PROFILES = { ios: "production", android: "preview" } as const;

/** A platform Pragma Go ships a binary for. */
export type Platform = keyof typeof RELEASE_PROFILES;

/** The fields of an `eas build:list --json` entry this script reads. */
export interface BuildSummary {
  id: string;
  appBuildVersion?: string | null;
  gitCommitHash?: string | null;
  fingerprint?: { hash?: string | null } | null;
  artifacts?: { buildUrl?: string | null; applicationArchiveUrl?: string | null } | null;
}

/** How one platform ships, and the evidence for it. */
export interface PlatformPlan {
  platform: Platform;
  profile: string;
  channel: string;
  fingerprint: string;
  action: "update" | "build";
  /** The existing build that already carries `fingerprint`, when `action` is `update`. */
  matchingBuild: BuildSummary | null;
  /** The newest build of the profile, for context when `action` is `build`. */
  latestBuild: BuildSummary | null;
}

/** Where the matching build's installable artifact can be downloaded, if anywhere. */
function artifactUrl(build: BuildSummary | null): string {
  const { buildUrl, applicationArchiveUrl } = build?.artifacts ?? {};
  return [buildUrl, applicationArchiveUrl].find(Boolean) ?? "";
}

/**
 * Ship as an update exactly when a finished build already has the fingerprint.
 * `matchingBuilds` is the result of filtering by that fingerprint, so any entry
 * is a match; the fingerprint is re-checked in case the filter is ever ignored.
 *
 * On Android that build's APK is re-attached to the release for a fresh
 * Obtainium install, so a match whose artifact has expired or was never
 * uploaded can't back an update — treat it as no match and build instead.
 */
export function decide(
  platform: Platform,
  channel: string,
  fingerprint: string,
  matchingBuilds: BuildSummary[],
  latestBuild: BuildSummary | null,
): PlatformPlan {
  const candidate = matchingBuilds.find((build) => build.fingerprint?.hash === fingerprint) ?? null;
  const matchingBuild =
    candidate && platform === "android" && !artifactUrl(candidate) ? null : candidate;
  return {
    platform,
    profile: RELEASE_PROFILES[platform],
    channel,
    fingerprint,
    action: matchingBuild ? "update" : "build",
    matchingBuild,
    latestBuild,
  };
}

function shortHash(hash: string | null | undefined): string {
  return hash ? `\`${hash.slice(0, 8)}\`` : "unknown";
}

const PLATFORM_LABELS: Record<Platform, string> = { ios: "iOS", android: "Android" };

function describeBuild(build: BuildSummary): string {
  const number = build.appBuildVersion ? `build ${build.appBuildVersion}` : "build";
  return `${number} (\`${build.id.slice(0, 8)}\`)`;
}

function describeUpdate(plan: PlatformPlan, matchingBuild: BuildSummary): string {
  return `over-the-air update on \`${plan.channel}\` — fingerprint ${shortHash(plan.fingerprint)} matches ${describeBuild(matchingBuild)}`;
}

function describeNewBinary(plan: PlatformPlan): string {
  const latest = plan.latestBuild;
  const previous = latest
    ? `; newest \`${plan.profile}\` build is ${describeBuild(latest)} at ${shortHash(latest.fingerprint?.hash)}`
    : "";
  return `**new binary** — no \`${plan.profile}\` build has fingerprint ${shortHash(plan.fingerprint)}${previous}`;
}

/** One human-readable line per platform, shared by the log and the PR comment. */
export function describePlan(plan: PlatformPlan): string {
  const how =
    plan.action === "update" && plan.matchingBuild
      ? describeUpdate(plan, plan.matchingBuild)
      : describeNewBinary(plan);
  return `**${PLATFORM_LABELS[plan.platform]}** → ${how}`;
}

/** The sticky release-PR comment. */
export function renderComment(plans: PlatformPlan[]): string {
  const lines = [
    COMMENT_MARKER,
    "### Pragma Go ship plan",
    "",
    ...plans.map((plan) => `- ${describePlan(plan)}`),
    "",
  ];
  const rebuilt = plans.find((plan) => plan.action === "build" && plan.latestBuild);
  if (rebuilt?.latestBuild) {
    lines.push(
      "A native input changed since the last binary. If that was not intended, name it with:",
      "",
      "```sh",
      `cd apps/pragma-go && PRAGMA_STORE_BUILD=1 eas fingerprint:compare --build-id ${rebuilt.latestBuild.id}`,
      "```",
      "",
    );
  }
  lines.push(
    "_Decided by `scripts/pragma-go-ship-plan.ts` when this PR merges; this comment is a preview._",
  );
  return `${lines.join("\n")}\n`;
}

/** The release channel an EAS build profile is bound to, read from `eas.json`. */
function channelFor(profile: string): string {
  const eas = JSON.parse(readFileSync(join(APP_DIR, "eas.json"), "utf8")) as {
    build: Record<string, { channel?: string }>;
  };
  const channel = eas.build[profile]?.channel;
  if (!channel) throw new Error(`eas.json build profile "${profile}" has no channel`);
  return channel;
}

// `PRAGMA_STORE_BUILD=1` is what the build profiles set on the worker. The app
// config only resolves identically with it, so without it every fingerprint
// here would differ from every build's and the plan would always say "build".
function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: APP_DIR,
    encoding: "utf8",
    env: { ...process.env, PRAGMA_STORE_BUILD: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function fingerprintOf(platform: Platform): string {
  const output = run("bunx", ["expo-updates", "fingerprint:generate", "--platform", platform]);
  const hash = (JSON.parse(output) as { hash?: string }).hash;
  if (!hash) throw new Error(`expo-updates produced no ${platform} fingerprint`);
  return hash;
}

function listBuilds(platform: Platform, extra: string[]): BuildSummary[] {
  const output = run("eas", [
    "build:list",
    "--platform",
    platform,
    "--profile",
    RELEASE_PROFILES[platform],
    "--status",
    "finished",
    "--json",
    "--non-interactive",
    ...extra,
  ]);
  return JSON.parse(output) as BuildSummary[];
}

function planFor(platform: Platform): PlatformPlan {
  const fingerprint = fingerprintOf(platform);
  const matching = listBuilds(platform, ["--fingerprint-hash", fingerprint, "--limit", "1"]);
  const [latest] = listBuilds(platform, ["--limit", "1"]);
  return decide(
    platform,
    channelFor(RELEASE_PROFILES[platform]),
    fingerprint,
    matching,
    latest ?? null,
  );
}

function outputLines(plan: PlatformPlan): string[] {
  const prefix = plan.platform;
  return [
    `${prefix}-action=${plan.action}`,
    `${prefix}-fingerprint=${plan.fingerprint}`,
    `${prefix}-channel=${plan.channel}`,
    `${prefix}-build-id=${plan.matchingBuild?.id ?? ""}`,
    `${prefix}-artifact-url=${artifactUrl(plan.matchingBuild)}`,
  ];
}

function writeOutputs(file: string, plans: PlatformPlan[]): void {
  appendFileSync(file, `${plans.flatMap(outputLines).join("\n")}\n`);
}

/** The file named by `--comment <file>`, or null when the flag is absent. */
function commentFileArg(argv: string[]): string | null {
  const index = argv.indexOf("--comment");
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function main(): void {
  const commentFile = commentFileArg(process.argv);

  const plans = (Object.keys(RELEASE_PROFILES) as Platform[]).map(planFor);
  for (const plan of plans) console.log(describePlan(plan));

  if (process.env.GITHUB_OUTPUT) writeOutputs(process.env.GITHUB_OUTPUT, plans);
  if (commentFile) writeFileSync(commentFile, renderComment(plans));
}

if (import.meta.main) main();
