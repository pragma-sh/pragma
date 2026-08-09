import { View, type ViewProps, type ViewStyle } from "react-native";

import { cn } from "@/lib/utils";

// Web counterpart of `GlassSurface.tsx`. Apple's liquid glass is a native
// material with no web equivalent, so this approximates it with a translucent
// card over `backdrop-filter`. It is a lookalike, not the real material: no
// specular highlight, no content-aware tint. Browsers without `backdrop-filter`
// (or with it disabled) simply see the translucent card, which is the same
// fallback Android gets.

interface GlassSurfaceProps extends ViewProps {
  className?: string;
  /** Glass tint style; the web approximation varies blur strength by it. */
  glassEffectStyle?: "regular" | "clear";
}

/** A surface that approximates liquid glass with a blurred, translucent card. */
export function GlassSurface({
  className,
  glassEffectStyle = "regular",
  children,
  style,
  ...props
}: GlassSurfaceProps) {
  return (
    <View
      className={cn("bg-card/70", className)}
      style={[glassStyle(glassEffectStyle), style]}
      {...props}
    >
      {children}
    </View>
  );
}

/**
 * `backdrop-filter` is a CSS property React Native has no equivalent for, so it
 * is not in `ViewStyle`. React Native Web forwards unrecognized style keys to
 * CSS, which is exactly what is wanted here.
 */
function glassStyle(variant: "regular" | "clear"): ViewStyle {
  const blur = variant === "clear" ? 12 : 24;
  return {
    backdropFilter: `blur(${blur}px) saturate(180%)`,
    WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
  } as ViewStyle;
}
