import { convertFileSrc } from "@tauri-apps/api/core";

import type { PluginRecord } from "./registry";

/** Resolves a plugin asset reference into a browser-readable URL. */
export function resolvePluginAssetPath(
  assetPath: string | undefined,
  record: PluginRecord,
): string | null {
  if (!assetPath) {
    return null;
  }
  if (/^(?:data:|blob:|https?:)/.test(assetPath)) {
    return assetPath;
  }
  const absolutePath = assetPath.startsWith("/")
    ? assetPath
    : record.dir
      ? `${record.dir.replace(/\/$/, "")}/${assetPath.replace(/^\.\//, "")}`
      : assetPath;
  return absolutePath.startsWith("/") ? convertFileSrc(absolutePath) : absolutePath;
}
