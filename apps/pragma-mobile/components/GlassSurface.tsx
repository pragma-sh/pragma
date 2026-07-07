// fallow-ignore-file unused-file -- Deliberate cross-platform glass primitive; AGENTS.md
// mandates screens go through it instead of expo-glass-effect, so it lands ahead of its
// first consumer like the rest of the components/ui primitive surface.
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { View, type ViewProps } from "react-native";

import { cn } from "@/lib/utils";

interface GlassSurfaceProps extends ViewProps {
  className?: string;
  /** Glass tint style when liquid glass is available. */
  glassEffectStyle?: "regular" | "clear";
}

// Liquid glass on Apple platforms (iOS 26+), with a solid themed card as the
// portable fallback everywhere else. Screens use this instead of reaching for
// expo-glass-effect directly so the fallback path lives in one spot.
const supportsGlass = isLiquidGlassAvailable();

/** A surface that renders Apple liquid glass where available, else a card. */
export function GlassSurface({
  className,
  glassEffectStyle = "regular",
  children,
  ...props
}: GlassSurfaceProps) {
  if (supportsGlass) {
    return (
      <GlassView glassEffectStyle={glassEffectStyle} style={props.style} {...props}>
        {children}
      </GlassView>
    );
  }
  return (
    <View className={cn("bg-card/95", className)} {...props}>
      {children}
    </View>
  );
}
