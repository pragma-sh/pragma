import { describe, expect, it } from "vitest";

import { hslChannels, themeColor, themeKey, themeVars } from "./theme-vars";

const NO_SOURCES = { global: false, project: false };

describe("themeKey", () => {
  it("changes when a color changes", () => {
    const before = themeKey({ colors: { dark: { background: "#000000" } }, sources: NO_SOURCES });
    const after = themeKey({ colors: { dark: { background: "#111111" } }, sources: NO_SOURCES });

    expect(before).not.toBe(after);
  });

  it("ignores everything but the colors, so a poll with no visual change is a no-op", () => {
    const colors = { dark: { background: "#000000" } };

    expect(themeKey({ colors, sources: { global: true, project: false } })).toBe(
      themeKey({ colors, sources: { global: true, project: true } }),
    );
  });
});

describe("themeVars", () => {
  it("converts desktop oklch overrides to hsl channel triples", () => {
    const vars = themeVars({ background: "oklch(1 0 0)", foreground: "oklch(0 0 0)" });

    expect(vars["--background"]).toBe("0 0% 100%");
    expect(vars["--foreground"]).toBe("0 0% 0%");
  });

  it("keeps only tokens this app declares", () => {
    const vars = themeVars({ sidebar: "#123456", "diff-added": "#00ff00", border: "#000000" });

    expect(Object.keys(vars)).toEqual(["--border"]);
  });

  it("drops values that are not colors", () => {
    expect(themeVars({ background: "not-a-color" })).toEqual({});
    expect(hslChannels("not-a-color")).toBeNull();
  });

  it("wraps a resolved color for native props", () => {
    expect(themeColor("#ff0000")).toBe("hsl(0 100% 50%)");
  });
});
