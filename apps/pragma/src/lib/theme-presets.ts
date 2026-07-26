import type { ThemeFile, ThemeOverrides } from "@/lib/theme";
import { cssColorToRgba, rgbaToOklch } from "@/lib/theme-color";
import { THEME_DEFAULTS, THEME_TOKENS, type ThemeMode } from "@/lib/theme-tokens";

interface ThemePalette {
  canvas: string;
  background: string;
  foreground: string;
  elevated: string;
  secondary: string;
  mutedForeground: string;
  primary: string;
  primaryHover: string;
  primaryForeground: string;
  border: string;
  input: string;
  selection: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  skill: string;
  skillForeground: string;
}

/** Published palette adapted to Pragma's semantic theme tokens. */
export interface ThemePreset {
  id: string;
  name: string;
  source: string;
  sourceUrl: string;
  light: ThemePalette;
  dark: ThemePalette;
  usesThemeDefaults?: boolean;
}

function palette(
  colors: Omit<
    ThemePalette,
    "destructiveForeground" | "successForeground" | "warningForeground" | "skillForeground"
  > & {
    stateForeground: string;
    warningForeground?: string;
  },
): ThemePalette {
  return {
    ...colors,
    destructiveForeground: colors.stateForeground,
    successForeground: colors.stateForeground,
    warningForeground: colors.warningForeground ?? colors.stateForeground,
    skillForeground: colors.stateForeground,
  };
}

function defaultColor(mode: ThemeMode, token: string): string {
  const value = THEME_DEFAULTS[mode][token];
  if (!value) throw new Error(`Missing Pragma default theme token: ${mode}.${token}`);
  return value;
}

function defaultPalette(mode: ThemeMode): ThemePalette {
  return {
    canvas: defaultColor(mode, "canvas"),
    background: defaultColor(mode, "background"),
    foreground: defaultColor(mode, "foreground"),
    elevated: defaultColor(mode, "elevated"),
    secondary: defaultColor(mode, "secondary"),
    mutedForeground: defaultColor(mode, "muted-foreground"),
    primary: defaultColor(mode, "primary"),
    primaryHover: defaultColor(mode, "primary-hover"),
    primaryForeground: defaultColor(mode, "primary-foreground"),
    border: defaultColor(mode, "border"),
    input: defaultColor(mode, "input"),
    selection: defaultColor(mode, "selection"),
    destructive: defaultColor(mode, "destructive"),
    destructiveForeground: defaultColor(mode, "destructive-foreground"),
    success: defaultColor(mode, "success"),
    successForeground: defaultColor(mode, "success-foreground"),
    warning: defaultColor(mode, "warning"),
    warningForeground: defaultColor(mode, "warning-foreground"),
    skill: defaultColor(mode, "skill"),
    skillForeground: defaultColor(mode, "skill-foreground"),
  };
}

/** Pragma's current shipped defaults, read directly from `index.css`. */
export const PRAGMA_THEME_PRESET: ThemePreset = {
  id: "pragma",
  name: "Pragma",
  source: "Pragma default",
  sourceUrl: "https://github.com/earendil-works/pragma",
  light: defaultPalette("light"),
  dark: defaultPalette("dark"),
  usesThemeDefaults: true,
};

/** Built-in themes sourced from official brand systems and original theme repositories. */
export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "github",
    name: "GitHub",
    source: "GitHub Primer",
    sourceUrl: "https://primer.style/primitives/colors",
    light: palette({
      canvas: "#f6f8fa",
      background: "#ffffff",
      foreground: "#1f2328",
      elevated: "#ffffff",
      secondary: "#eff2f5",
      mutedForeground: "#59636e",
      primary: "#0969da",
      primaryHover: "#0860ca",
      primaryForeground: "#ffffff",
      border: "#d1d9e0",
      input: "#818b98",
      selection: "#54aeff66",
      destructive: "#cf222e",
      success: "#1a7f37",
      warning: "#9a6700",
      skill: "#8250df",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#010409",
      background: "#0d1117",
      foreground: "#f0f6fc",
      elevated: "#161b22",
      secondary: "#21262d",
      mutedForeground: "#8b949e",
      primary: "#2f81f7",
      primaryHover: "#388bfd",
      primaryForeground: "#ffffff",
      border: "#30363d",
      input: "#484f58",
      selection: "#1f6feb66",
      destructive: "#f85149",
      success: "#3fb950",
      warning: "#d29922",
      skill: "#a371f7",
      stateForeground: "#0d1117",
    }),
  },
  {
    id: "vercel",
    name: "Vercel",
    source: "Vercel Geist (2026)",
    sourceUrl: "https://vercel.com/geist/colors",
    light: palette({
      canvas: "#fafafa",
      background: "#ffffff",
      foreground: "#000000",
      elevated: "#ffffff",
      secondary: "#f2f2f2",
      mutedForeground: "#666666",
      primary: "#171717",
      primaryHover: "#4d4d4d",
      primaryForeground: "#ffffff",
      border: "#eaeaea",
      input: "#999999",
      selection: "#0070f333",
      destructive: "#fc0035",
      success: "#28a948",
      warning: "#ffb200",
      skill: "#9f00f4",
      stateForeground: "#ffffff",
      warningForeground: "#000000",
    }),
    dark: palette({
      canvas: "#000000",
      background: "#000000",
      foreground: "#ffffff",
      elevated: "#1a1a1a",
      secondary: "#1a1a1a",
      mutedForeground: "#a1a1a1",
      primary: "#ededed",
      primaryHover: "#a0a0a0",
      primaryForeground: "#000000",
      border: "#2e2e2e",
      input: "#454545",
      selection: "#0070f766",
      destructive: "#f13242",
      success: "#00ab3e",
      warning: "#ffb200",
      skill: "#9440d5",
      stateForeground: "#000000",
    }),
  },
  {
    id: "vscode",
    name: "VS Code",
    source: "Microsoft Light / Dark Modern",
    sourceUrl: "https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes",
    light: palette({
      canvas: "#f8f8f8",
      background: "#ffffff",
      foreground: "#3b3b3b",
      elevated: "#f8f8f8",
      secondary: "#e5e5e5",
      mutedForeground: "#616161",
      primary: "#005fb8",
      primaryHover: "#0258a8",
      primaryForeground: "#ffffff",
      border: "#e5e5e5",
      input: "#cecece",
      selection: "#add6ff80",
      destructive: "#cd3131",
      success: "#16825d",
      warning: "#bf8803",
      skill: "#af00db",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#181818",
      background: "#1f1f1f",
      foreground: "#cccccc",
      elevated: "#202020",
      secondary: "#2b2b2b",
      mutedForeground: "#9d9d9d",
      primary: "#0078d4",
      primaryHover: "#026ec1",
      primaryForeground: "#ffffff",
      border: "#2b2b2b",
      input: "#3c3c3c",
      selection: "#add6ff26",
      destructive: "#f44747",
      success: "#16825d",
      warning: "#cca700",
      skill: "#c586c0",
      stateForeground: "#ffffff",
    }),
  },
  {
    id: "one",
    name: "Atom One",
    source: "One Light / One Dark",
    sourceUrl: "https://github.com/akamud/vscode-theme-onedark",
    light: palette({
      canvas: "#eaeaeb",
      background: "#fafafa",
      foreground: "#383a42",
      elevated: "#ffffff",
      secondary: "#e5e5e6",
      mutedForeground: "#424243",
      primary: "#526fff",
      primaryHover: "#6b83ed",
      primaryForeground: "#ffffff",
      border: "#dbdbdc",
      input: "#dbdbdc",
      selection: "#e5e5e6",
      destructive: "#e45649",
      success: "#50a14f",
      warning: "#986801",
      skill: "#a626a4",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#21252b",
      background: "#282c34",
      foreground: "#abb2bf",
      elevated: "#2c313a",
      secondary: "#3e4451",
      mutedForeground: "#9da5b4",
      primary: "#528bff",
      primaryHover: "#6087cf",
      primaryForeground: "#ffffff",
      border: "#3a3f4b",
      input: "#3a3f4b",
      selection: "#3e4451",
      destructive: "#e06c75",
      success: "#98c379",
      warning: "#e5c07b",
      skill: "#c678dd",
      stateForeground: "#282c34",
    }),
  },
  {
    id: "solarized",
    name: "Solarized",
    source: "Ethan Schoonover",
    sourceUrl: "https://github.com/altercation/solarized",
    light: palette({
      canvas: "#fdf6e3",
      background: "#fdf6e3",
      foreground: "#586e75",
      elevated: "#fdf6e3",
      secondary: "#eee8d5",
      mutedForeground: "#586e75",
      primary: "#268bd2",
      primaryHover: "#6c71c4",
      primaryForeground: "#fdf6e3",
      border: "#93a1a1",
      input: "#839496",
      selection: "#eee8d5",
      destructive: "#dc322f",
      success: "#859900",
      warning: "#b58900",
      skill: "#d33682",
      stateForeground: "#fdf6e3",
    }),
    dark: palette({
      canvas: "#002b36",
      background: "#002b36",
      foreground: "#93a1a1",
      elevated: "#073642",
      secondary: "#586e75",
      mutedForeground: "#93a1a1",
      primary: "#268bd2",
      primaryHover: "#6c71c4",
      primaryForeground: "#fdf6e3",
      border: "#586e75",
      input: "#657b83",
      selection: "#586e75",
      destructive: "#dc322f",
      success: "#859900",
      warning: "#b58900",
      skill: "#d33682",
      stateForeground: "#002b36",
    }),
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    source: "morhetz Gruvbox",
    sourceUrl: "https://github.com/morhetz/gruvbox",
    light: palette({
      canvas: "#fbf1c7",
      background: "#fbf1c7",
      foreground: "#3c3836",
      elevated: "#ebdbb2",
      secondary: "#d5c4a1",
      mutedForeground: "#504945",
      primary: "#076678",
      primaryHover: "#427b58",
      primaryForeground: "#fbf1c7",
      border: "#bdae93",
      input: "#a89984",
      selection: "#d5c4a1",
      destructive: "#9d0006",
      success: "#79740e",
      warning: "#b57614",
      skill: "#8f3f71",
      stateForeground: "#fbf1c7",
    }),
    dark: palette({
      canvas: "#282828",
      background: "#282828",
      foreground: "#ebdbb2",
      elevated: "#3c3836",
      secondary: "#504945",
      mutedForeground: "#a89984",
      primary: "#83a598",
      primaryHover: "#8ec07c",
      primaryForeground: "#282828",
      border: "#665c54",
      input: "#7c6f64",
      selection: "#504945",
      destructive: "#fb4934",
      success: "#b8bb26",
      warning: "#fabd2f",
      skill: "#d3869b",
      stateForeground: "#282828",
    }),
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    source: "Latte / Mocha",
    sourceUrl: "https://github.com/catppuccin/palette",
    light: palette({
      canvas: "#e6e9ef",
      background: "#eff1f5",
      foreground: "#4c4f69",
      elevated: "#e6e9ef",
      secondary: "#acb0be",
      mutedForeground: "#5c5f77",
      primary: "#8839ef",
      primaryHover: "#8839ef",
      primaryForeground: "#dce0e8",
      border: "#acb0be",
      input: "#ccd0da",
      selection: "#7c7f934d",
      destructive: "#d20f39",
      success: "#40a02b",
      warning: "#df8e1d",
      skill: "#8839ef",
      stateForeground: "#eff1f5",
    }),
    dark: palette({
      canvas: "#11111b",
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      elevated: "#181825",
      secondary: "#585b70",
      mutedForeground: "#a6adc8",
      primary: "#cba6f7",
      primaryHover: "#cba6f7",
      primaryForeground: "#11111b",
      border: "#585b70",
      input: "#313244",
      selection: "#9399b240",
      destructive: "#f38ba8",
      success: "#a6e3a1",
      warning: "#f9e2af",
      skill: "#cba6f7",
      stateForeground: "#1e1e2e",
    }),
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    source: "Dawn / Main",
    sourceUrl: "https://github.com/rose-pine/palette",
    light: palette({
      canvas: "#faf4ed",
      background: "#faf4ed",
      foreground: "#575279",
      elevated: "#fffaf3",
      secondary: "#f2e9e1",
      mutedForeground: "#575279",
      primary: "#d7827e",
      primaryHover: "#d7827ee6",
      primaryForeground: "#faf4ed",
      border: "#6e6a8614",
      input: "#6e6a8614",
      selection: "#6e6a8614",
      destructive: "#b4637a",
      success: "#56949f",
      warning: "#ea9d34",
      skill: "#907aa9",
      stateForeground: "#faf4ed",
    }),
    dark: palette({
      canvas: "#191724",
      background: "#191724",
      foreground: "#e0def4",
      elevated: "#1f1d2e",
      secondary: "#1f1d2e",
      mutedForeground: "#908caa",
      primary: "#ebbcba",
      primaryHover: "#ebbcbae6",
      primaryForeground: "#191724",
      border: "#6e6a8633",
      input: "#6e6a8633",
      selection: "#6e6a8633",
      destructive: "#eb6f92",
      success: "#9ccfd8",
      warning: "#f6c177",
      skill: "#c4a7e7",
      stateForeground: "#191724",
    }),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    source: "Enkia Tokyo Night",
    sourceUrl: "https://github.com/enkia/tokyo-night-vscode-theme",
    light: palette({
      canvas: "#d6d8df",
      background: "#e6e7ed",
      foreground: "#343b58",
      elevated: "#dcdee3",
      secondary: "#dadce3",
      mutedForeground: "#363c4d",
      primary: "#2959aa",
      primaryHover: "#3e6396",
      primaryForeground: "#ffffff",
      border: "#c1c2c7",
      input: "#9da0ab",
      selection: "#acb0bf40",
      destructive: "#942f2f",
      success: "#33635c",
      warning: "#8f5e15",
      skill: "#5a3e8e",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#16161e",
      background: "#1a1b26",
      foreground: "#a9b1d6",
      elevated: "#202330",
      secondary: "#3b3e52",
      mutedForeground: "#a9b1d6",
      primary: "#3d59a1",
      primaryHover: "#7aa2f7",
      primaryForeground: "#ffffff",
      border: "#292e42",
      input: "#545c7e",
      selection: "#515c7e4d",
      destructive: "#f7768e",
      success: "#73daca",
      warning: "#e0af68",
      skill: "#bb9af7",
      stateForeground: "#1a1b26",
    }),
  },
  {
    id: "ayu",
    name: "Ayu",
    source: "Ayu Colors (2026)",
    sourceUrl: "https://github.com/ayu-theme/ayu-colors",
    light: palette({
      canvas: "#f8f9fa",
      background: "#fcfcfc",
      foreground: "#5c6166",
      elevated: "#ffffff",
      secondary: "#fafafa",
      mutedForeground: "#5c6166",
      primary: "#f29718",
      primaryHover: "#f29718",
      primaryForeground: "#5c6166",
      border: "#6b7d8f1f",
      input: "#6b7d8f1f",
      selection: "#035bd626",
      destructive: "#e65050",
      success: "#6cbf43",
      warning: "#eba400",
      skill: "#a37acc",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#0d1017",
      background: "#10141c",
      foreground: "#bfbdb6",
      elevated: "#0f131a",
      secondary: "#141821",
      mutedForeground: "#bfbdb6",
      primary: "#e6b450",
      primaryHover: "#e6b450",
      primaryForeground: "#0d1017",
      border: "#1b1f29",
      input: "#47526640",
      selection: "#3388ff40",
      destructive: "#d95757",
      success: "#70bf56",
      warning: "#ffb454",
      skill: "#d2a6ff",
      stateForeground: "#0d1017",
    }),
  },
  {
    id: "zed",
    name: "Zed",
    source: "Zed Default",
    sourceUrl: "https://github.com/zed-industries/zed/tree/main/crates/theme/src",
    light: palette({
      canvas: "#f9f9f8",
      background: "#fdfdfc",
      foreground: "#21201c",
      elevated: "#fdfdfc",
      secondary: "#f1f0ef",
      mutedForeground: "#63635e",
      primary: "#0d74ce",
      primaryHover: "#0588f0",
      primaryForeground: "#ffffff",
      border: "#dad9d6",
      input: "#e2e1de",
      selection: "#e6f4fe40",
      destructive: "#dc3e42",
      success: "#2b9a66",
      warning: "#ef5f00",
      skill: "#8347b9",
      stateForeground: "#ffffff",
    }),
    dark: palette({
      canvas: "#22252b",
      background: "#282c33",
      foreground: "#d7dadf",
      elevated: "#262931",
      secondary: "#2f333d",
      mutedForeground: "#abb2bf",
      primary: "#62adef",
      primaryHover: "#3b9eff",
      primaryForeground: "#22252b",
      border: "#1b1d23",
      input: "#3b3d45",
      selection: "#62adef40",
      destructive: "#e06c75",
      success: "#98c379",
      warning: "#e5c07b",
      skill: "#bc74d2",
      stateForeground: "#22252b",
    }),
  },
];

/** Every choice shown in the built-in theme menu, with Pragma first. */
export const THEME_OPTIONS: readonly ThemePreset[] = [PRAGMA_THEME_PRESET, ...THEME_PRESETS];

const presetColorsCache = new WeakMap<ThemePreset, Record<ThemeMode, ThemeOverrides>>();

function paletteOverrides(value: ThemePalette): ThemeOverrides {
  return {
    canvas: value.canvas,
    background: value.background,
    foreground: value.foreground,
    elevated: value.elevated,
    card: value.elevated,
    "card-foreground": value.foreground,
    popover: value.elevated,
    "popover-foreground": value.foreground,
    primary: value.primary,
    "primary-foreground": value.primaryForeground,
    "primary-hover": value.primaryHover,
    secondary: value.secondary,
    "secondary-foreground": value.foreground,
    muted: value.secondary,
    "muted-foreground": value.mutedForeground,
    accent: value.secondary,
    "accent-foreground": value.foreground,
    border: value.border,
    input: value.input,
    ring: value.primary,
    selection: value.selection,
    overlay: `${value.foreground}66`,
    destructive: value.destructive,
    "destructive-foreground": value.destructiveForeground,
    success: value.success,
    "success-foreground": value.successForeground,
    warning: value.warning,
    "warning-foreground": value.warningForeground,
    skill: value.skill,
    "skill-foreground": value.skillForeground,
    "diff-added": value.success,
    "diff-removed": value.destructive,
    sidebar: value.canvas,
    "sidebar-foreground": value.mutedForeground,
    "sidebar-primary": value.primary,
    "sidebar-primary-foreground": value.primaryForeground,
    "sidebar-accent": value.secondary,
    "sidebar-accent-foreground": value.foreground,
    "sidebar-border": value.border,
    "sidebar-ring": value.primary,
  };
}

function oklchOverrides(overrides: ThemeOverrides): ThemeOverrides {
  return Object.fromEntries(
    Object.entries(overrides).map(([token, value]) => {
      const rgba = value ? cssColorToRgba(value) : null;
      if (!rgba) throw new Error(`Invalid color in built-in theme: ${value ?? token}`);
      return [token, rgbaToOklch(rgba)];
    }),
  );
}

/** Produces persisted `oklch(...)` overrides for both modes of a preset. */
export function themePresetColors(preset: ThemePreset): Record<ThemeMode, ThemeOverrides> {
  const cached = presetColorsCache.get(preset);
  if (cached) return cached;
  const colors = preset.usesThemeDefaults
    ? {
        light: Object.fromEntries(
          THEME_TOKENS.map((token) => [token, THEME_DEFAULTS.light[token]]),
        ),
        dark: Object.fromEntries(THEME_TOKENS.map((token) => [token, THEME_DEFAULTS.dark[token]])),
      }
    : {
        light: oklchOverrides(paletteOverrides(preset.light)),
        dark: oklchOverrides(paletteOverrides(preset.dark)),
      };
  presetColorsCache.set(preset, colors);
  return colors;
}

/** Replaces a scope's colors with one preset while preserving unrelated metadata. */
export function withThemePreset(file: ThemeFile | null, preset: ThemePreset): ThemeFile {
  const next = { ...file };
  if (preset.usesThemeDefaults) delete next.colors;
  else next.colors = themePresetColors(preset);
  return next;
}

/** Reports whether a theme file currently contains exactly this preset. */
export function isThemePreset(file: ThemeFile | null, preset: ThemePreset): boolean {
  if (!file?.colors) return false;
  return JSON.stringify(file.colors) === JSON.stringify(themePresetColors(preset));
}
