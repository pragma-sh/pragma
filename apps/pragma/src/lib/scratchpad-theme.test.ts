import { describe, expect, it } from "vitest";

import { scratchpadTheme } from "@/lib/scratchpad-theme";
import { THEME_DEFAULTS } from "@/lib/theme-tokens";

describe("scratchpadTheme", () => {
  it("emits every themeable token for the active color scheme", () => {
    const root = document.createElement("html");
    root.classList.add("dark");
    document.body.append(root);

    const theme = scratchpadTheme(root);

    expect(theme.mode).toBe("dark");
    expect(theme.css).toContain("color-scheme:dark");
    expect(theme.css).toContain(`--background:${THEME_DEFAULTS.dark.background}`);
    expect(theme.css).toContain(`--primary:${THEME_DEFAULTS.dark.primary}`);
    expect(theme.css).toContain("--font-mono:");
    root.remove();
  });

  it("falls back to the light block when the root is not dark", () => {
    const root = document.createElement("html");

    const theme = scratchpadTheme(root);

    expect(theme.mode).toBe("light");
    expect(theme.css).toContain(`--background:${THEME_DEFAULTS.light.background}`);
  });

  it("prefers the value computed on the root over the shipped default", () => {
    const root = document.createElement("html");
    root.classList.add("dark");
    root.style.setProperty("--primary", "oklch(0.7 0.2 20)");
    document.body.append(root);

    expect(scratchpadTheme(root).css).toContain("--primary:oklch(0.7 0.2 20)");
    root.remove();
  });
});
