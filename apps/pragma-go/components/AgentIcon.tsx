import type { AgentIcon as AgentIconRef } from "@pragma/sdk";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, View } from "react-native";
import { SvgCss } from "react-native-svg/css";

import { useConnection } from "@/lib/connection-context";
import {
  colorLuminance,
  ICON_BACKDROP_COLOR,
  needsIconBackdrop,
  svgForBackground,
} from "@/lib/icon-contrast";
import { useThemeColors } from "@/lib/theme";
import { Text } from "./ui/text";

// Agent icons are plugin-contributed assets fetched by content hash through the
// authenticated SDK transport (never a bare Image URL — the bearer token must
// ride the request header). SVG bytes render via SvgCss; raster bytes via a
// data-URI Image. Results are cached by hash for the session.

type ResolvedIcon = { kind: "svg"; xml: string } | { kind: "raster"; uri: string };

const iconCache = new Map<string, ResolvedIcon>();

interface AgentIconProps {
  icon?: AgentIconRef | null;
  /** Emoji/glyph shown while loading or when no icon is available. */
  fallback: string;
  size?: number;
}

/** Renders a plugin agent icon fetched by hash, with an emoji fallback. */
export function AgentIcon({ icon, fallback, size = 24 }: AgentIconProps) {
  const { client } = useConnection();
  const [resolved, setResolved] = useState<ResolvedIcon | null>(
    icon ? (iconCache.get(icon.hash) ?? null) : null,
  );

  useEffect(() => {
    if (!icon || !client) {
      setResolved(null);
      return undefined;
    }
    const cached = iconCache.get(icon.hash);
    if (cached) {
      setResolved(cached);
      return undefined;
    }
    let cancelled = false;
    void loadIcon(client, icon, () => cancelled, setResolved);
    return () => {
      cancelled = true;
    };
  }, [icon, client]);

  return <AgentIconContent fallback={fallback} resolved={resolved} size={size} />;
}

async function loadIcon(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
  icon: AgentIconRef,
  isCancelled: () => boolean,
  setResolved: (icon: ResolvedIcon | null) => void,
): Promise<void> {
  try {
    const resolved = await fetchIcon(client, icon);
    if (!isCancelled()) setResolved(resolved);
  } catch {
    if (!isCancelled()) setResolved(null);
  }
}

async function fetchIcon(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
  icon: AgentIconRef,
): Promise<ResolvedIcon> {
  const asset = await client.assets.fetch(icon.hash);
  const resolved = await resolveIconBytes(client, icon, asset.bytes);
  iconCache.set(icon.hash, resolved);
  return resolved;
}

/** Decodes fetched icon bytes into the form its renderer takes. */
async function resolveIconBytes(
  client: NonNullable<ReturnType<typeof useConnection>["client"]>,
  icon: AgentIconRef,
  bytes: Uint8Array,
): Promise<ResolvedIcon> {
  if (!icon.mime.includes("svg")) {
    return { kind: "raster", uri: await client.assets.toDataUri(icon.hash) };
  }
  return { kind: "svg", xml: new TextDecoder().decode(bytes) };
}

function AgentIconContent({
  fallback,
  resolved,
  size,
}: {
  fallback: string;
  resolved: ResolvedIcon | null;
  size: number;
}) {
  const { background, foreground } = useThemeColors();
  const backgroundLuminance = colorLuminance(background);
  // An SVG is repainted to clear the contrast floor before it is drawn; only a
  // raster mark — whose pixels this can neither measure nor repaint — falls back
  // to the neutral backdrop.
  const xml = useMemo(
    () => (resolved?.kind === "svg" ? svgForBackground(resolved.xml, backgroundLuminance) : null),
    [resolved, backgroundLuminance],
  );
  if (!resolved) return <Text style={{ color: foreground, fontSize: size }}>{fallback}</Text>;
  return (
    <IconSurface
      backdrop={resolved.kind === "raster" && needsIconBackdrop(null, backgroundLuminance)}
      size={size}
    >
      {resolved.kind === "svg" ? (
        // SvgCss, not SvgXml: brand marks that declare their fills in a
        // `<style>` block (Cursor) render unpainted — a black silhouette — with
        // the plain XML renderer. `color` resolves any `currentColor` paint to
        // the theme foreground instead of the default black.
        <SvgCss
          color={foreground}
          height={size}
          preserveAspectRatio="xMidYMid meet"
          width={size}
          xml={xml ?? resolved.xml}
        />
      ) : (
        <Image
          resizeMode="contain"
          source={{ uri: resolved.uri }}
          style={{ width: size, height: size }}
        />
      )}
    </IconSurface>
  );
}

/**
 * The icon's box. A low-contrast icon sits on the neutral backdrop, inset so
 * the mark keeps breathing room and the chip stays the same outer size as a
 * bare icon.
 */
function IconSurface({
  backdrop,
  children,
  size,
}: {
  backdrop: boolean;
  children: ReactNode;
  size: number;
}) {
  const padding = backdrop ? Math.max(2, Math.round(size * 0.15)) : 0;
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        width: size + padding * 2,
        height: size + padding * 2,
        padding,
        ...(backdrop
          ? { backgroundColor: ICON_BACKDROP_COLOR, borderRadius: Math.round(size * 0.3) }
          : {}),
      }}
    >
      {children}
    </View>
  );
}
