import { createHash } from "node:crypto";

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
  manifestJson?: string;
  manifestSignature?: string;
}

export interface ReleaseDocument {
  manifest: ReleaseManifest;
  manifestJson: string;
  manifestSignature: string;
}

/** Selects newest safe offer, falling back through UI releases to a native installer. */
export function evaluateUpdates(args: {
  documents: Array<Partial<ReleaseDocument> & Pick<ReleaseDocument, "manifest">>;
  platform: string;
  running: Partial<Record<(typeof SHIPPED_QUERY_KEYS)[number], string>>;
}): UpdateCheckResponse {
  const { documents, platform, running } = args;
  return (
    documents
      .map((document) => evaluateUpdate({ ...document, platform, running }))
      .find((candidate) => candidate.available) ?? { available: false }
  );
}

const SHIPPED_QUERY_KEYS = ["ui", "app", "server", "protocol"] as const;

const COMPONENT_BY_QUERY: Record<(typeof SHIPPED_QUERY_KEYS)[number], string> = {
  ui: "ui",
  app: "app",
  server: "pragma-server",
  protocol: "pragma-protocol",
};

const CACHE_MS = 60_000;

/** Valid tar overlay served by `/api/updates/asset` in development. */
export const DEV_UI_OVERLAY = developmentOverlayTar();

/** SHA-256 of [`DEV_UI_OVERLAY`]. */
const DEV_UI_OVERLAY_SHA256 = createHash("sha256").update(DEV_UI_OVERLAY).digest("hex");

let cached: { expires: number; documents: ReleaseDocument[] } | null = null;

function developmentOverlayTar(): Uint8Array {
  const contents = new TextEncoder().encode(
    "<!doctype html><html><body><main>Pragma development UI overlay</main></body></html>",
  );
  const blocks = Math.ceil(contents.length / 512);
  const archive = new Uint8Array(512 + blocks * 512 + 1024);
  const header = archive.subarray(0, 512);
  writeTarField(header, 0, 100, "index.html");
  writeTarField(header, 100, 8, "0000644\0");
  writeTarField(header, 108, 8, "0000000\0");
  writeTarField(header, 116, 8, "0000000\0");
  writeTarField(header, 124, 12, `${contents.length.toString(8).padStart(11, "0")}\0`);
  writeTarField(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  archive.set(contents, 512);
  return archive;
}

function writeTarField(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) throw new Error(`tar field exceeds ${length} bytes`);
  header.set(bytes, offset);
}

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
  manifestJson?: string;
  manifestSignature?: string;
  platform: string;
  running: Partial<Record<(typeof SHIPPED_QUERY_KEYS)[number], string>>;
}): UpdateCheckResponse {
  const { manifest, platform, running } = args;
  const nativeBehind = (["app", "server", "protocol"] as const).some((key) =>
    componentIsBehind(manifest, running, key),
  );
  if (manifest.apply === "reload" && nativeBehind) {
    return { available: false };
  }
  if (!SHIPPED_QUERY_KEYS.some((key) => componentIsBehind(manifest, running, key))) {
    return { available: false };
  }
  const assetKey = updateAssetKey(manifest.apply, platform);
  const asset = manifest.assets[assetKey];
  if (!asset) return { available: false };
  return {
    available: true,
    apply: manifest.apply,
    notes: manifest.notes,
    changelogUrl: manifest.changelogUrl,
    version: updateVersion(manifest),
    asset,
    manifestJson: args.manifestJson ?? `${JSON.stringify(manifest, null, 2)}\n`,
    manifestSignature: args.manifestSignature ?? "",
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
  return released !== undefined && isNewerVersion(released, current);
}

function isNewerVersion(released: string, current: string): boolean {
  const next = parseVersion(released);
  const running = parseVersion(current);
  if (!next || !running) return false;
  for (const index of [0, 1, 2] as const) {
    const difference = next.core[index] - running.core[index];
    if (difference !== 0) return difference > 0;
  }
  if (next.pre.length === 0) return running.pre.length > 0;
  if (running.pre.length === 0) return false;
  const length = Math.max(next.pre.length, running.pre.length);
  for (let index = 0; index < length; index += 1) {
    const left = next.pre[index];
    const right = running.pre[index];
    if (left === undefined) return false;
    if (right === undefined) return true;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber;
    if (leftNumber !== null) return false;
    if (rightNumber !== null) return true;
    return left > right;
  }
  return false;
}

function parseVersion(value: string): { core: [number, number, number]; pre: string[] } | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split(".") ?? [],
  };
}

function updateAssetKey(apply: ApplyMode, platform: string): string {
  return apply === "reload" ? "ui" : platform;
}

function updateVersion(manifest: ReleaseManifest): string {
  const component = manifest.apply === "reload" ? manifest.components.ui : manifest.components.app;
  return component ?? manifest.gitSha;
}

/** Fetches recent signed desktop manifests through the newest restart release. */
export async function loadGithubManifests(now = Date.now()): Promise<ReleaseDocument[]> {
  const existing = cachedManifests(now);
  if (existing) return existing;
  const headers = githubHeaders();
  const assetUrls = await recentManifestUrls(headers);
  const documents: ReleaseDocument[] = [];
  for (const urls of assetUrls) {
    // oxlint-disable-next-line no-await-in-loop -- stop after first restart manifest to bound GitHub requests.
    const document = await fetchManifest(urls, headers);
    if (!document) continue;
    documents.push(document);
    if (document.manifest.apply === "restart") break;
  }
  if (documents.length > 0) {
    cached = { expires: now + CACHE_MS, documents };
  }
  return documents;
}

function cachedManifests(now: number): ReleaseDocument[] | null {
  if (!cached) return null;
  return cached.expires > now ? cached.documents : null;
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

async function recentManifestUrls(
  headers: Record<string, string>,
): Promise<Array<{ manifest: string; signature: string }>> {
  const releaseUrl = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}/releases?per_page=100`;
  const releaseRes = await fetch(releaseUrl, { headers, cache: "no-store" });
  if (!releaseRes.ok) return [];
  const releases = (await releaseRes.json()) as Array<{
    draft?: boolean;
    prerelease?: boolean;
    assets?: Array<{ name: string; browser_download_url: string }>;
  }>;
  return releases.flatMap((release) => {
    if (release.draft || release.prerelease) return [];
    const manifest = release.assets?.find((asset) => asset.name === "release.json");
    const signature = release.assets?.find((asset) => asset.name === "release.json.sig");
    return manifest && signature
      ? [{ manifest: manifest.browser_download_url, signature: signature.browser_download_url }]
      : [];
  });
}

async function fetchManifest(
  urls: { manifest: string; signature: string },
  headers: Record<string, string>,
): Promise<ReleaseDocument | null> {
  const [manifestRes, signatureRes] = await Promise.all([
    fetch(urls.manifest, { headers, cache: "no-store" }),
    fetch(urls.signature, { headers, cache: "no-store" }),
  ]);
  if (!manifestRes.ok || !signatureRes.ok) return null;
  const manifestJson = await manifestRes.text();
  const manifest = JSON.parse(manifestJson) as ReleaseManifest;
  if (manifest.schemaVersion !== 1) return null;
  return {
    manifest,
    manifestJson,
    manifestSignature: (await signatureRes.text()).trim(),
  };
}

/** True in `next dev`, where there is not yet a GitHub Release to poll. */
export function useDevFixture(): boolean {
  return process.env.NODE_ENV !== "production";
}
