import { useColorScheme } from "react-native";

const LIGHT_COLORS = {
  background: "hsl(0 0% 100%)",
  foreground: "hsl(240 10% 4%)",
  mutedForeground: "hsl(240 4% 46%)",
  primaryForeground: "hsl(0 0% 98%)",
} as const;

const DARK_COLORS = {
  background: "hsl(240 10% 4%)",
  foreground: "hsl(0 0% 98%)",
  mutedForeground: "hsl(240 5% 65%)",
  primaryForeground: "hsl(240 6% 10%)",
} as const;

/** Theme colors for native props that cannot consume NativeWind classes. */
export function useThemeColors() {
  return useColorScheme() === "dark" ? DARK_COLORS : LIGHT_COLORS;
}
