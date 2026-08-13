import { useMemo } from "react";
import { useColorScheme } from "react-native";

import { useHostThemeOverrides } from "./theme-context";
import { themeColor, type ThemeOverrides } from "./theme-vars";

/** Colors this app hands to native props, mirroring `global.css` defaults. */
export interface ThemeColors {
  background: string;
  foreground: string;
  mutedForeground: string;
  primaryForeground: string;
}

const LIGHT_COLORS: ThemeColors = {
  background: "hsl(0 0% 100%)",
  foreground: "hsl(240 10% 4%)",
  mutedForeground: "hsl(240 4% 46%)",
  primaryForeground: "hsl(0 0% 98%)",
};

const DARK_COLORS: ThemeColors = {
  background: "hsl(240 10% 4%)",
  foreground: "hsl(0 0% 98%)",
  mutedForeground: "hsl(240 5% 65%)",
  primaryForeground: "hsl(240 6% 10%)",
};

/** Which desktop theme token backs each native-prop color. */
const TOKEN_FOR_COLOR: Record<keyof ThemeColors, string> = {
  background: "background",
  foreground: "foreground",
  mutedForeground: "muted-foreground",
  primaryForeground: "primary-foreground",
};

/**
 * Theme colors for native props that cannot consume NativeWind classes
 * (navigation headers, `placeholderTextColor`, menu tints).
 *
 * Class-driven colors come from the NativeWind variables `ThemeProvider`
 * applies; these are the same overrides resolved eagerly for props that need a
 * literal color string, so both paths mirror the host theme identically.
 */
export function useThemeColors(): ThemeColors {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const overrides = useHostThemeOverrides();
  return useMemo(
    () => withOverrides(scheme === "dark" ? DARK_COLORS : LIGHT_COLORS, overrides),
    [scheme, overrides],
  );
}

/** Replaces each base color the host theme overrides; leaves the rest shipped. */
function withOverrides(base: ThemeColors, overrides: ThemeOverrides): ThemeColors {
  const resolved = { ...base };
  for (const [name, token] of Object.entries(TOKEN_FOR_COLOR)) {
    const value = overrides[token];
    const color = value ? themeColor(value) : null;
    if (color) resolved[name as keyof ThemeColors] = color;
  }
  return resolved;
}
