import { convertFileSrc } from "@tauri-apps/api/core";
import { CircleUser } from "lucide-react";

import { useIconNeedsInvert } from "@/lib/icon-contrast";
import { cn } from "@/lib/utils";

/**
 * Resolves a provider's plugin-relative icon to a webview URL. A remote host's
 * plugin directory is a path on that host, so it has no local URL.
 */
export function providerIconSrc(
  iconPath: string | null,
  pluginDir: string | null,
  isRemote: boolean,
): string | null {
  if (!iconPath) return null;
  if (/^(?:data:|blob:|https?:)/.test(iconPath)) return iconPath;
  if (isRemote) return null;
  const absolute = iconPath.startsWith("/")
    ? iconPath
    : pluginDir
      ? `${pluginDir.replace(/\/$/, "")}/${iconPath.replace(/^\.\//, "")}`
      : null;
  return absolute ? convertFileSrc(absolute) : null;
}

/** A provider's mark, falling back to a generic account glyph. */
export function ProviderIcon({ src, className }: { src: string | null; className?: string }) {
  const needsInvert = useIconNeedsInvert(src);
  return src ? (
    <img
      alt=""
      className={cn("size-4 shrink-0 rounded-sm", needsInvert && "invert", className)}
      src={src}
    />
  ) : (
    <CircleUser className={cn("size-4 shrink-0 text-muted-foreground", className)} />
  );
}
