import { beforeEach, describe, expect, it } from "vitest";

import {
  applyThemeOverrides,
  mergeThemeOverrides,
  parseThemeFile,
  resolveThemeToken,
  serializeThemeFile,
  themeOverridesCss,
  withThemeOverride,
} from "@/lib/theme";
import { cssColorToRgba, cssColorToRgbaString, rgbaToOklch } from "@/lib/theme-color";
import { THEME_DEFAULTS } from "@/lib/theme-tokens";

describe("parseThemeFile", () => {
  it("treats an empty document as no overrides", () => {
    expect(parseThemeFile("")).toEqual({});
    expect(parseThemeFile("{}")).toEqual({});
  });

  it("parses per-mode color blocks", () => {
    const file = parseThemeFile(
      JSON.stringify({ colors: { dark: { primary: "#ff0000" }, light: { ring: "#00ff00" } } }),
    );
    expect(file.colors?.dark?.primary).toBe("#ff0000");
    expect(file.colors?.light?.ring).toBe("#00ff00");
  });

  it("keeps unrecognised top-level keys so a rewrite does not drop them", () => {
    const file = parseThemeFile(JSON.stringify({ $schema: "./theme.schema.json", colors: {} }));
    expect(file.$schema).toBe("./theme.schema.json");
  });

  it("rejects structural mistakes", () => {
    expect(() => parseThemeFile("[]")).toThrow("root must be an object");
    expect(() => parseThemeFile(JSON.stringify({ colors: 3 }))).toThrow("`colors` must be");
    expect(() => parseThemeFile(JSON.stringify({ colors: { dark: 3 } }))).toThrow("`colors.dark`");
    expect(() => parseThemeFile(JSON.stringify({ colors: { dark: { primary: 3 } } }))).toThrow(
      "must be a color string",
    );
    expect(() => parseThemeFile(JSON.stringify({ colors: { dark: { primary: "nope" } } }))).toThrow(
      "not a valid CSS color",
    );
  });
});

describe("mergeThemeOverrides", () => {
  const global = parseThemeFile(
    JSON.stringify({ colors: { dark: { primary: "#111111", ring: "#222222" } } }),
  );
  const project = parseThemeFile(JSON.stringify({ colors: { dark: { ring: "#333333" } } }));

  it("layers project over global, per token", () => {
    expect(mergeThemeOverrides("dark", global, project)).toEqual({
      primary: "#111111",
      ring: "#333333",
    });
  });

  it("ignores tokens Pragma does not know about", () => {
    const stray = parseThemeFile(JSON.stringify({ colors: { dark: { nonsense: "#444444" } } }));
    expect(mergeThemeOverrides("dark", stray)).toEqual({});
  });

  it("keeps modes independent", () => {
    expect(mergeThemeOverrides("light", global, project)).toEqual({});
  });

  it("drops final values matching stylesheet defaults", () => {
    const custom = parseThemeFile(
      JSON.stringify({ colors: { dark: { sidebar: THEME_DEFAULTS.dark.sidebar } } }),
    );
    expect(mergeThemeOverrides("dark", custom)).toEqual({});
  });

  it("lets a project stylesheet default cancel a global override", () => {
    const globalOverride = parseThemeFile(
      JSON.stringify({ colors: { dark: { sidebar: "#111111" } } }),
    );
    const projectDefault = parseThemeFile(
      JSON.stringify({ colors: { dark: { sidebar: THEME_DEFAULTS.dark.sidebar } } }),
    );
    expect(mergeThemeOverrides("dark", globalOverride, projectDefault)).toEqual({});
  });
});

describe("resolveThemeToken", () => {
  it("falls back to the stylesheet default", () => {
    expect(resolveThemeToken("dark", "primary", {})).toBe(THEME_DEFAULTS.dark.primary);
    expect(resolveThemeToken("dark", "primary", { primary: "#abcdef" })).toBe("#abcdef");
  });
});

describe("withThemeOverride", () => {
  it("sets and removes a token", () => {
    const set = withThemeOverride(null, "dark", "primary", "#ff0000");
    expect(set.colors?.dark?.primary).toBe("#ff0000");
    const cleared = withThemeOverride(set, "dark", "primary", null);
    expect(cleared.colors).toBeUndefined();
  });

  it("leaves other modes and keys alone", () => {
    const start = parseThemeFile(
      JSON.stringify({ $schema: "x", colors: { light: { ring: "#00ff00" } } }),
    );
    const next = withThemeOverride(start, "dark", "primary", "#ff0000");
    expect(next.$schema).toBe("x");
    expect(next.colors?.light?.ring).toBe("#00ff00");
    expect(next.colors?.dark?.primary).toBe("#ff0000");
  });

  it("serializes as pretty JSON with a trailing newline", () => {
    expect(serializeThemeFile(withThemeOverride(null, "dark", "ring", "#ff0000"))).toBe(
      '{\n  "colors": {\n    "dark": {\n      "ring": "#ff0000"\n    }\n  }\n}\n',
    );
  });
});

describe("themeOverridesCss", () => {
  it("emits doubled selectors so overrides outrank defaults", () => {
    const css = themeOverridesCss({ dark: { primary: "#ff0000" }, light: { ring: "#00ff00" } });
    expect(css).toContain(".dark.dark {\n  --primary: #ff0000;\n}");
    expect(css).toContain(":root:root {\n  --ring: #00ff00;\n}");
  });

  it("keeps a themed sidebar translucent under macOS vibrancy", () => {
    const css = themeOverridesCss({ dark: { sidebar: "#112233" } });
    expect(css).toContain(".dark.dark {\n  --sidebar: #112233;\n}");
    expect(css).toContain(
      ".dark.dark.vibrancy {\n  --sidebar: color-mix(in oklch, #112233 40%, transparent);\n}",
    );
  });

  it("is empty when nothing is overridden", () => {
    expect(themeOverridesCss({ dark: {}, light: {} })).toBe("");
  });
});

describe("applyThemeOverrides", () => {
  beforeEach(() => {
    document.querySelector("#pragma-theme-overrides")?.remove();
  });

  it("injects, updates and removes the stylesheet", () => {
    applyThemeOverrides({ dark: { primary: "#ff0000" } });
    const style = document.querySelector("#pragma-theme-overrides");
    expect(style?.textContent).toContain("--primary: #ff0000;");
    expect(style?.parentElement).toBe(document.head);

    applyThemeOverrides({ dark: { primary: "#00ff00" } });
    expect(document.querySelector("#pragma-theme-overrides")?.textContent).toContain("#00ff00");

    applyThemeOverrides({});
    expect(document.querySelector("#pragma-theme-overrides")).toBeNull();
  });

  it("stays last in head so equal-specificity defaults lose", () => {
    applyThemeOverrides({ dark: { primary: "#ff0000" } });
    document.head.append(document.createElement("style"));
    applyThemeOverrides({ dark: { primary: "#0000ff" } });
    expect(document.head.lastElementChild?.id).toBe("pragma-theme-overrides");
  });
});

describe("color conversion", () => {
  it("round-trips a picker tuple through oklch", () => {
    const oklch = rgbaToOklch([99, 102, 241, 1]);
    expect(oklch).toMatch(/^oklch\(/);
    expect(cssColorToRgba(oklch)).toEqual([99, 102, 241, 1]);
  });

  it("keeps alpha", () => {
    expect(rgbaToOklch([0, 0, 0, 0.5])).toContain("/ 0.5");
    expect(cssColorToRgbaString("oklch(0.52 0.16 252 / 0.2)")).toMatch(/, 0\.2\)$/);
  });

  it("clamps colors outside the sRGB gamut", () => {
    const rgba = cssColorToRgba("oklch(0.78 0.13 152)");
    expect(rgba?.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
  });

  it("returns null for non-colors", () => {
    expect(cssColorToRgba("not-a-color")).toBeNull();
  });
});
