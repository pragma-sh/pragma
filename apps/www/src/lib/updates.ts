import { gitConfig } from "@/lib/shared";

/** How a desktop client should apply this release. */
export type ApplyMode = "reload" | "restart";

/** One downloadable file in `release.json`. */
export interface ReleaseAsset {
  url: string;
  sha256: string;
  signature: string;
}

/** GitHub Release asset published after binaries exist. */
export interface ReleaseManifest {
  schemaVersion: 1;
  releasedAt: string;
  gitSha: string;
  apply: ApplyMode;
  notes: string;
  changelogUrl: string;
  components: Record<string, string>;
  assets: Record<string, ReleaseAsset>;
}

/** JSON the desktop polls. */
export interface UpdateCheckResponse {
  available: boolean;
  apply?: ApplyMode;
  notes?: string;
  changelogUrl?: string;
  version?: string;
  asset?: ReleaseAsset;
}

const SHIPPED_QUERY_KEYS = ["ui", "app", "server", "protocol"] as const;

const COMPONENT_BY_QUERY: Record<(typeof SHIPPED_QUERY_KEYS)[number], string> = {
  ui: "ui",
  app: "app",
  server: "pragma-server",
  protocol: "pragma-protocol",
};

const CACHE_MS = 60_000;

/** Bytes served by `/api/updates/asset` in development. */
export const DEV_UI_OVERLAY = "pragma-dev-ui-overlay-fixture\n";

/** SHA-256 of [`DEV_UI_OVERLAY`]. */
const DEV_UI_OVERLAY_SHA256 = "9ef0ce84de1330939c937deb9fbe2d33b02580677430afddbeb3c7074bffdd7a";

let cached: { expires: number; manifest: ReleaseManifest } | null = null;

/**
 * Stand-in `release.json` for `next dev`, so a local check works before the
 * first GitHub Release exists. Apply mode is on the manifest, same as production.
 */
export function fixtureManifest(): ReleaseManifest {
  return {
    schemaVersion: 1,
    releasedAt: new Date().toISOString(),
    gitSha: "dev-fixture",
    apply: "reload",
    notes: "Local fixture: UI-only reload. Click Install Update; the app server stays up.",
    changelogUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases`,
    components: {
      ui: "0.0.1",
      app: "0.0.0",
      "pragma-server": "0.0.0",
      "pragma-protocol": "0.0.0",
    },
    assets: {
      ui: {
        url: "/api/updates/asset",
        sha256: DEV_UI_OVERLAY_SHA256,
        signature: "",
      },
    },
  };
}

/**
 * Compares running shipped-into-the-app versions against the manifest.
 * A desktop offer is only `available` when a shipped component differs.
 */
export function evaluateUpdate(args: {
  manifest: ReleaseManifest;
  platform: string;
  running: Partial<Record<(typeof SHIPPED_QUERY_KEYS)[number], string>>;
}): UpdateCheckResponse {
  const { manifest, platform, running } = args;
  if (!SHIPPED_QUERY_KEYS.some((key) => componentIsBehind(manifest, running, key))) {
    return { available: false };
  }
  const assetKey = updateAssetKey(manifest.apply, platform);
  const asset = manifest.assets[assetKey];
  return {
    available: true,
    apply: manifest.apply,
    notes: manifest.notes,
    changelogUrl: manifest.changelogUrl,
    version: updateVersion(manifest),
    asset,
  };
}

function componentIsBehind(
  manifest: ReleaseManifest,
  running: Partial<Record<(typeof SHIPPED_QUERY_KEYS)[number], string>>,
  key: (typeof SHIPPED_QUERY_KEYS)[number],
): boolean {
  const current = running[key];
  if (!current) return false;
  const released = manifest.components[COMPONENT_BY_QUERY[key]];
  return released !== undefined && released !== current;
}

function updateAssetKey(apply: ApplyMode, platform: string): string {
  return apply === "reload" ? "ui" : platform;
}

function updateVersion(manifest: ReleaseManifest): string {
  const component = manifest.apply === "reload" ? manifest.components.ui : manifest.components.app;
  return component ?? manifest.gitSha;
}

/** Fetches `release.json` from the latest GitHub Release, with a one-minute cache. */
export async function loadGithubManifest(now = Date.now()): Promise<ReleaseManifest | null> {
  const existing = cachedManifest(now);
  if (existing) return existing;
  const headers = githubHeaders();
  const assetUrl = await latestManifestUrl(headers);
  if (!assetUrl) return null;
  const manifest = await fetchManifest(assetUrl, headers);
  if (!manifest) return null;
  cached = { expires: now + CACHE_MS, manifest };
  return manifest;
}

function cachedManifest(now: number): ReleaseManifest | null {
  if (!cached) return null;
  return cached.expires > now ? cached.manifest : null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pragma-updates",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function latestManifestUrl(headers: Record<string, string>): Promise<string | null> {
  const releaseUrl = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}/releases/latest`;
  const releaseRes = await fetch(releaseUrl, { headers, cache: "no-store" });
  if (!releaseRes.ok) return null;
  const release = (await releaseRes.json()) as {
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const asset = release.assets?.find((item) => item.name === "release.json");
  return asset?.browser_download_url ?? null;
}

async function fetchManifest(
  assetUrl: string,
  headers: Record<string, string>,
): Promise<ReleaseManifest | null> {
  const manifestRes = await fetch(assetUrl, { headers, cache: "no-store" });
  if (!manifestRes.ok) return null;
  const manifest = (await manifestRes.json()) as ReleaseManifest;
  if (manifest.schemaVersion !== 1) return null;
  return manifest;
}

/** True in `next dev`, where there is not yet a GitHub Release to poll. */
export function useDevFixture(): boolean {
  return process.env.NODE_ENV !== "production";
}
