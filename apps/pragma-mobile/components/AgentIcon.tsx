import type { AgentIcon as AgentIconRef } from "@pragma/sdk";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { useConnection } from "@/lib/connection-context";
import { Text } from "./ui/text";

// Agent icons are plugin-contributed assets fetched by content hash through the
// authenticated SDK transport (never a bare Image URL — the bearer token must
// ride the request header). SVG bytes render via SvgXml; raster bytes via a
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
    void (async () => {
      try {
        const asset = await client.assets.fetch(icon.hash);
        const next: ResolvedIcon = icon.mime.includes("svg")
          ? { kind: "svg", xml: new TextDecoder().decode(asset.bytes) }
          : { kind: "raster", uri: await client.assets.toDataUri(icon.hash) };
        iconCache.set(icon.hash, next);
        if (!cancelled) setResolved(next);
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [icon, client]);

  if (!resolved) {
    return <Text style={{ fontSize: size }}>{fallback}</Text>;
  }
  if (resolved.kind === "svg") {
    return (
      <View style={{ width: size, height: size }}>
        <SvgXml height={size} width={size} xml={resolved.xml} />
      </View>
    );
  }
  return <Image source={{ uri: resolved.uri }} style={{ width: size, height: size }} />;
}
