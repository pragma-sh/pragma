import { describe, expect, it } from "vitest";

import {
  THEME_DEFAULTS,
  THEME_TOKEN_GROUPS,
  THEME_TOKENS,
  themeTokenLabel,
} from "@/lib/theme-tokens";

describe("theme token catalog", () => {
  it("parses defaults for both modes out of index.css", () => {
    expect(THEME_DEFAULTS.dark.background).toBe("oklch(0.2 0.006 256)");
    expect(THEME_DEFAULTS.light.background).toBe("oklch(1 0 0)");
    expect(THEME_DEFAULTS.dark.sidebar).toBe("oklch(0.15 0.006 256)");
  });

  it("ignores non-color variables and the vibrancy overrides", () => {
    expect(THEME_DEFAULTS.light.radius).toBeUndefined();
    // `.dark.vibrancy` re-declares `--sidebar` translucent; the `.dark` block wins.
    expect(THEME_DEFAULTS.dark.sidebar).not.toContain("/");
  });

  it("declares the same tokens in light and dark", () => {
    expect(Object.keys(THEME_DEFAULTS.light).toSorted()).toEqual(
      Object.keys(THEME_DEFAULTS.dark).toSorted(),
    );
  });

  it("places every stylesheet color token in exactly one group", () => {
    expect(THEME_TOKENS.toSorted()).toEqual(Object.keys(THEME_DEFAULTS.dark).toSorted());
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length);
  });

  it("gives every group at least one token", () => {
    for (const group of THEME_TOKEN_GROUPS) expect(group.tokens.length).toBeGreaterThan(0);
  });

  it("labels tokens readably", () => {
    expect(themeTokenLabel("sidebar-primary-foreground")).toBe("Sidebar primary foreground");
    expect(themeTokenLabel("ring")).toBe("Ring");
  });
});
