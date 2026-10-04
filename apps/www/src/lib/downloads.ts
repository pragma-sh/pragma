import { githubHeaders, repoApiUrl } from "./github-api";

/** A desktop operating system Pragma ships an installer for. */
export type DownloadPlatform = "macos" | "windows" | "linux";

/** CPU family, as far as a browser will say. */
export type DownloadArch = "arm" | "x86";

/**
 * Every installer a desktop release uploads, keyed by the `<platform>` part of its asset
 * name. `.github/workflows/release.yml` names them `Pragma-<version>-<target>.<extension>`,
 * so the key and extension together identify an asset without knowing the version.
 */
export const DOWNLOAD_TARGETS = {
  "darwin-aarch64": { platform: "macos", extension: "dmg", label: "macOS (Apple silicon)" },
  "darwin-x86_64": { platform: "macos", extension: "dmg", label: "macOS (Intel)" },
  "windows-aarch64": { platform: "windows", extension: "exe", label: "Windows (ARM64)" },
  "windows-x86_64": { platform: "windows", extension: "exe", label: "Windows (x64)" },
  "linux-x86_64-deb": { platform: "linux", extension: "deb", label: "Linux x64 (.deb)" },
  "linux-x86_64-rpm": { platform: "linux", extension: "rpm", label: "Linux x64 (.rpm)" },
  "linux-aarch64-deb": { platform: "linux", extension: "deb", label: "Linux ARM64 (.deb)" },
  "linux-aarch64-rpm": { platform: "linux", extension: "rpm", label: "Linux ARM64 (.rpm)" },
} as const satisfies Record<
  string,
  { platform: DownloadPlatform; extension: string; label: string }
>;

/** One installer a desktop release carries. */
export type DownloadTarget = keyof typeof DOWNLOAD_TARGETS;

/** Human name of each platform, for button copy. */
export const PLATFORM_LABELS: Record<DownloadPlatform, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** Route that redirects to the latest release's installer for `target`. */
export function downloadRoute(target: DownloadTarget): string {
  return `/download/${target}`;
}

/** True when `value` names a known installer — the route's only accepted input. */
export function isDownloadTarget(value: string): value is DownloadTarget {
  return Object.hasOwn(DOWNLOAD_TARGETS, value);
}

/** What a browser reports about the machine it runs on. */
export interface ClientHints {
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `navigator.userAgentData.platform` or `navigator.platform`, when exposed. */
  platform?: string;
  /** `navigator.maxTouchPoints`; iPadOS Safari claims to be a Mac and only this tells. */
  maxTouchPoints?: number;
}

/** Devices with no desktop installer; checked before any platform rule. */
const NO_INSTALLER = /Android|iPhone|iPad|iPod|CrOS/i;

/** First match wins, so `Win` must precede anything a Windows string could contain. */
const PLATFORM_PATTERNS: Array<[DownloadPlatform, RegExp]> = [
  ["windows", /Win/i],
  ["macos", /Mac/i],
  ["linux", /Linux|X11/i],
];

/** Matches a user agent string or a bare client-hint value (`"arm"`, `"x86"`). */
const ARCH_PATTERNS: Array<[DownloadArch, RegExp]> = [
  ["arm", /^arm$|aarch64|arm64|armv8/i],
  ["x86", /^x86$|x86_64|x86-64|Win64|x64|amd64|i686/i],
];

function firstMatch<T>(patterns: Array<[T, RegExp]>, text: string): T | null {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/**
 * The desktop platform a visitor is on, or `null` for a phone, a tablet, or anything
 * unrecognised — those get the release page rather than a guess. The reported platform
 * wins over the user agent string, which browsers freeze and spoof.
 */
export function detectPlatform(hints: ClientHints): DownloadPlatform | null {
  if (NO_INSTALLER.test(hints.userAgent)) return null;
  const platform = reportedPlatform(hints);
  return platform === "macos" && isTouchDevice(hints) ? null : platform;
}

function reportedPlatform(hints: ClientHints): DownloadPlatform | null {
  return (
    firstMatch(PLATFORM_PATTERNS, hints.platform ?? "") ??
    firstMatch(PLATFORM_PATTERNS, hints.userAgent)
  );
}

/** iPadOS Safari reports a Mac; only its touch points give it away. */
function isTouchDevice(hints: ClientHints): boolean {
  return (hints.maxTouchPoints ?? 0) > 1;
}

/** The CPU family a user agent string or architecture hint names outright, if any. */
export function archFromUserAgent(userAgent: string): DownloadArch | null {
  return firstMatch(ARCH_PATTERNS, userAgent);
}

/**
 * Best installer for a platform. macOS defaults to Apple silicon — Safari reports every
 * Mac as Intel, so the user agent cannot be trusted there, and every Mac sold since 2023
 * is Apple silicon. Linux defaults to `.deb`, the more common package format; the release
 * page lists the rest.
 */
export function defaultTarget(
  platform: DownloadPlatform,
  arch: DownloadArch | null,
): DownloadTarget {
  return DEFAULT_TARGETS[platform][arch ?? DEFAULT_ARCH[platform]];
}

const DEFAULT_TARGETS: Record<DownloadPlatform, Record<DownloadArch, DownloadTarget>> = {
  macos: { arm: "darwin-aarch64", x86: "darwin-x86_64" },
  windows: { arm: "windows-aarch64", x86: "windows-x86_64" },
  linux: { arm: "linux-aarch64-deb", x86: "linux-x86_64-deb" },
};

const DEFAULT_ARCH: Record<DownloadPlatform, DownloadArch> = {
  macos: "arm",
  windows: "x86",
  linux: "x86",
};

/** A release asset as the GitHub REST API returns it. */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** The download URL of `target`'s installer among a release's assets, if it has one. */
export function findInstallerUrl(assets: ReleaseAsset[], target: DownloadTarget): string | null {
  const suffix = `-${target}.${DOWNLOAD_TARGETS[target].extension}`;
  const asset = assets.find(
    (entry) => entry.name.startsWith("Pragma-") && entry.name.endsWith(suffix),
  );
  return asset?.browser_download_url ?? null;
}

/** How long one read of the latest release serves every download redirect. */
const CACHE_MS = 5 * 60_000;
let cached: { expires: number; assets: ReleaseAsset[] } | null = null;

/**
 * Assets of the repository's Latest release. `scripts/pin-latest-desktop-release.ts`
 * keeps that flag on the newest desktop release with installers, so this is one request
 * rather than a scan of every component release.
 */
export async function loadLatestReleaseAssets(now = Date.now()): Promise<ReleaseAsset[]> {
  if (cached && cached.expires > now) return cached.assets;
  const assets = await fetchLatestReleaseAssets();
  if (assets.length > 0) cached = { expires: now + CACHE_MS, assets };
  return assets;
}

async function fetchLatestReleaseAssets(): Promise<ReleaseAsset[]> {
  const res = await fetch(`${repoApiUrl}/releases/latest`, {
    headers: githubHeaders("pragma-downloads"),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const release = (await res.json()) as { assets?: ReleaseAsset[] };
  return release.assets ?? [];
}

/** Drops the in-process release cache. Tests only. */
export function resetDownloadCache(): void {
  cached = null;
}
