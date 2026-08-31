/** Color schemes supported by Pragma themes. */
export type ThemeMode = "light" | "dark";

/** Theme token overrides for one color scheme, keyed without the `--` prefix. */
export type ThemeColors = Record<ThemeMode, Record<string, string>>;

/** A selectable theme contributed to Pragma's Theme settings. */
export interface ThemeDefinition {
  /** Stable id within this plugin. */
  id: string;
  /** Human-readable name shown in Theme settings. */
  name: string;
  /** Optional detail shown under the theme name. */
  description?: string;
  /** Light and dark Pragma theme-token overrides. */
  colors: ThemeColors;
}

/** Declares a theme contribution. */
export function defineTheme(input: ThemeDefinition): ThemeDefinition {
  return input;
}
