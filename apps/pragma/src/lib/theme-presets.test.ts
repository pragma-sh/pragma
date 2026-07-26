import { describe, expect, it } from "vitest";
import { wcagContrast } from "culori";

import {
  PRAGMA_THEME_PRESET,
  THEME_OPTIONS,
  THEME_PRESETS,
  isThemePreset,
  themePresetColors,
  withThemePreset,
} from "@/lib/theme-presets";
import { THEME_DEFAULTS, THEME_TOKENS } from "@/lib/theme-tokens";

describe("theme presets", () => {
  it("provides unique, sourced presets with light and dark ramps", () => {
    expect(THEME_PRESETS).toHaveLength(11);
    expect(new Set(THEME_PRESETS.map((preset) => preset.id)).size).toBe(11);

    for (const preset of THEME_PRESETS) {
      expect(preset.sourceUrl).toMatch(/^https:\/\//);
      const colors = themePresetColors(preset);
      for (const mode of ["light", "dark"] as const) {
        expect(Object.keys(colors[mode])).toEqual(expect.arrayContaining([...THEME_TOKENS]));
        expect(
          Object.values(colors[mode]).every(
            (value) => typeof value === "string" && value.startsWith("oklch("),
          ),
        ).toBe(true);
      }
    }
  });

  it("lists the stylesheet-backed Pragma default first", () => {
    expect(THEME_OPTIONS).toHaveLength(12);
    expect(THEME_OPTIONS[0]).toBe(PRAGMA_THEME_PRESET);
    expect(PRAGMA_THEME_PRESET.name).toBe("Pragma");

    const colors = themePresetColors(PRAGMA_THEME_PRESET);
    expect(colors.light.primary).toBe(THEME_DEFAULTS.light.primary);
    expect(colors.dark.secondary).toBe(THEME_DEFAULTS.dark.secondary);
  });

  it("keeps canonical upstream palette anchors", () => {
    const expected = {
      github: ["dark", "background", "#0d1117"],
      vercel: ["dark", "primary", "#ededed"],
      vscode: ["dark", "background", "#1f1f1f"],
      one: ["dark", "border", "#3a3f4b"],
      solarized: ["dark", "background", "#002b36"],
      gruvbox: ["dark", "background", "#282828"],
      catppuccin: ["dark", "primary", "#cba6f7"],
      "rose-pine": ["light", "primary", "#d7827e"],
      "tokyo-night": ["dark", "canvas", "#16161e"],
      ayu: ["dark", "background", "#10141c"],
      zed: ["dark", "canvas", "#22252b"],
    } as const;

    for (const [id, [mode, token, value]] of Object.entries(expected)) {
      const preset = THEME_PRESETS.find((candidate) => candidate.id === id);
      expect(preset?.[mode][token]).toBe(value);
    }
  });

  it("keeps active and inactive tab labels readable", () => {
    const lowContrast: string[] = [];
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const active = wcagContrast(preset[mode].foreground, preset[mode].elevated);
        const inactive = wcagContrast(preset[mode].mutedForeground, preset[mode].canvas);
        if (active < 4.5) lowContrast.push(`${preset.name} ${mode} active ${active.toFixed(2)}`);
        if (inactive < 4.5) {
          lowContrast.push(`${preset.name} ${mode} inactive ${inactive.toFixed(2)}`);
        }
      }
    }
    expect(lowContrast).toEqual([]);
  });

  it("keeps VS Code Modern shell surfaces neutral", () => {
    const preset = THEME_PRESETS.find((candidate) => candidate.id === "vscode");
    expect(preset?.light).toMatchObject({
      canvas: "#f8f8f8",
      background: "#ffffff",
      elevated: "#f8f8f8",
      border: "#e5e5e5",
    });
    expect(preset?.dark).toMatchObject({
      canvas: "#181818",
      background: "#1f1f1f",
      elevated: "#202020",
      border: "#2b2b2b",
    });
  });

  it("replaces colors while preserving unrelated theme metadata", () => {
    const preset = THEME_PRESETS[0];
    if (!preset) throw new Error("missing built-in theme preset");

    const file = withThemePreset({ $schema: "./theme.schema.json", note: "keep me" }, preset);
    expect(file.$schema).toBe("./theme.schema.json");
    expect(file.note).toBe("keep me");
    expect(isThemePreset(file, preset)).toBe(true);
    const otherPreset = THEME_PRESETS[1];
    if (!otherPreset) throw new Error("missing second built-in theme preset");
    expect(isThemePreset(file, otherPreset)).toBe(false);
  });

  it("clears color overrides when selecting the stylesheet-backed default", () => {
    const preset = THEME_PRESETS[0];
    if (!preset) throw new Error("missing built-in theme preset");
    const file = withThemePreset(
      { $schema: "./theme.schema.json", colors: themePresetColors(preset) },
      PRAGMA_THEME_PRESET,
    );
    expect(file).toEqual({ $schema: "./theme.schema.json" });
  });
});
