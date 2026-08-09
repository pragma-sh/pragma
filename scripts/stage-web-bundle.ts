/// <reference types="node" />

// Exports the Pragma Go web bundle and stages it into the desktop app's Tauri
// resources, where `pragma-gateway` serves it from under the web base path.
//
// Why a manifest instead of letting the gateway walk the directory:
//
//   * The gateway serves exactly what this file lists, looked up as a map key.
//     A request path is never joined onto a filesystem path, so path traversal
//     is not expressible rather than merely defended against.
//   * Text assets are stored **gzipped only**. Every browser sends
//     `Accept-Encoding: gzip`, so this is what ships over the wire anyway;
//     keeping a second uncompressed copy would add ~4 MB to every installer for
//     a case that effectively never happens (the gateway decompresses on the
//     fly for the client that does).
//   * The `ETag` is the hash of the *uncompressed* bytes, so it stays stable if
//     the compression level ever changes.
//
// This runs before desktop dev and release builds so Tauri copies the current
// bundle into its resource directory before the gateway starts. It remains
// skippable (`PRAGMA_SKIP_WEB=1`) for builds that do not need the browser app.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { constants } from "@pragma/constants";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(repoRoot, "apps", "pragma-go");
const exportDir = join(appDir, "dist");
const stageDir = join(
  repoRoot,
  "apps",
  "pragma",
  "src-tauri",
  "resources",
  constants.gateway.web.resourceDir,
);

/** Content types by file extension; anything unlisted is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Extensions worth compressing. The rest are already compressed formats. */
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".ttf", ".txt"]);

/** Below this, gzip's framing costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

/** One entry in the manifest the gateway loads at startup. */
interface ManifestAsset {
  path: string;
  file: string;
  contentType: string;
  gzip: boolean;
  etag: string;
  immutable: boolean;
}

function main(): void {
  if (process.env.PRAGMA_SKIP_WEB === "1") {
    console.log("stage-web-bundle: skipped (PRAGMA_SKIP_WEB=1)");
    return;
  }
  exportBundle();
  const assets = stage();
  const bytes = assets.reduce(
    (total, asset) => total + statSync(join(stageDir, asset.file)).size,
    0,
  );
  console.log(
    `stage-web-bundle: ${assets.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB -> ${relative(repoRoot, stageDir)}`,
  );
}

/** Runs the Expo web export, with the base path the gateway serves under. */
function exportBundle(): void {
  const result = spawnSync("bun", ["run", "export:web"], {
    cwd: appDir,
    env: { ...process.env, EXPO_BASE_URL: constants.gateway.web.basePath },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`expo export failed with status ${String(result.status)}`);
  }
}

/** Copies the export into the resource directory and writes the manifest. */
function stage(): ManifestAsset[] {
  if (!existsSync(join(exportDir, "index.html"))) {
    throw new Error(`no web export found at ${exportDir}`);
  }
  // Wipe first: a stale hashed bundle left behind would be served forever, since
  // its own cache headers promise it is immutable.
  rmSync(stageDir, { force: true, recursive: true });
  mkdirSync(stageDir, { recursive: true });

  const assets = walk(exportDir).map((absolute) => stageOne(absolute));
  writeFileSync(
    join(stageDir, constants.gateway.web.manifestFile),
    `${JSON.stringify({ basePath: constants.gateway.web.basePath, assets }, null, 2)}\n`,
  );
  return assets;
}

/** Writes one exported file into the stage directory, compressed if it pays. */
function stageOne(absolute: string): ManifestAsset {
  const urlPath = relative(exportDir, absolute).split(sep).join("/");
  const raw = readFileSync(absolute);
  const extension = urlPath.slice(urlPath.lastIndexOf("."));
  const compress = shouldCompress(extension, raw.byteLength);
  // Flattened onto one level: a nested tree buys nothing when every lookup goes
  // through the manifest, and it keeps the resource directory easy to inspect.
  const file = `${hash(urlPath, 16)}${compress ? ".gz" : extension}`;
  writeFileSync(join(stageDir, file), compress ? gzipSync(raw, { level: 9 }) : raw);
  return {
    path: urlPath,
    file,
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    gzip: compress,
    // Hash the *uncompressed* bytes so the ETag survives a compression change.
    etag: hash(raw, 32),
    immutable: isContentHashed(urlPath),
  };
}

/** Whether gzip is worth it: a text format, and big enough to beat its framing. */
function shouldCompress(extension: string, byteLength: number): boolean {
  return COMPRESSIBLE.has(extension) && byteLength >= MIN_COMPRESS_BYTES;
}

function hash(value: string | Buffer, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Whether a file's own name pins its content, and so can be cached forever.
 * Metro emits `entry-<32 hex>.js`; `index.html` names those files and therefore
 * must be revalidated on every load or an updated app would never be picked up.
 */
function isContentHashed(urlPath: string): boolean {
  return /-[0-9a-f]{16,}\.\w+$/.test(urlPath);
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

main();
