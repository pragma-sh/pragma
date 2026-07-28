import { afterEach, describe, expect, it } from "vitest";

import { buildDesignPrompt, isLocalPortUrl, readDesignPalette } from "./design-mode";
import type { BrowserDesignStage } from "./tauri";

function stage(overrides: Partial<BrowserDesignStage> = {}): BrowserDesignStage {
  return {
    tabId: "tab-1",
    prompt: "make the hero bigger",
    html: '<section class="hero">Hi</section>',
    selector: "body > main > section",
    ancestors: "body > div#root > main.container",
    route: "/pricing",
    url: "http://localhost:5173/pricing",
    ...overrides,
  };
}

describe("readDesignPalette", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("resolves the app's theme tokens to concrete values", () => {
    document.documentElement.style.setProperty("--primary", "oklch(0.56 0.15 252)");
    document.documentElement.style.setProperty("--popover", "oklch(0.23 0.007 256)");
    document.documentElement.style.setProperty("--ring", "oklch(0.62 0.15 252)");

    const palette = readDesignPalette();

    expect(palette.primary).toBe("oklch(0.56 0.15 252)");
    expect(palette.surface).toBe("oklch(0.23 0.007 256)");
    expect(palette.ring).toBe("oklch(0.62 0.15 252)");
  });

  it("returns empty strings for unset tokens so the overlay keeps its fallbacks", () => {
    const palette = readDesignPalette();

    expect(palette.primary).toBe("");
    expect(palette.mutedForeground).toBe("");
  });
});

describe("isLocalPortUrl", () => {
  it("accepts loopback hosts with an explicit port", () => {
    expect(isLocalPortUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalPortUrl("http://127.0.0.1:3000/app")).toBe(true);
    expect(isLocalPortUrl("http://[::1]:8080")).toBe(true);
    expect(isLocalPortUrl("http://app.localhost:4321/")).toBe(true);
  });

  it("rejects loopback hosts without a port", () => {
    expect(isLocalPortUrl("https://localhost/")).toBe(false);
  });

  it("rejects remote hosts, blanks, and unparsable input", () => {
    expect(isLocalPortUrl("https://example.com:8443/")).toBe(false);
    expect(isLocalPortUrl("")).toBe(false);
    expect(isLocalPortUrl(null)).toBe(false);
    expect(isLocalPortUrl("not a url")).toBe(false);
  });
});

describe("buildDesignPrompt", () => {
  it("shares the origin and port the app is running on", () => {
    const prompt = buildDesignPrompt([stage()], "http://localhost:5173/pricing");

    expect(prompt).toContain("http://localhost:5173 (port 5173)");
    expect(prompt).toContain("Verify each change");
  });

  it("includes each change's route, markup, and the user's own words", () => {
    const prompt = buildDesignPrompt(
      [stage(), stage({ prompt: "blue button", route: "/", selector: "body > button" })],
      "http://localhost:5173/pricing",
    );

    expect(prompt).toContain("## Change 1");
    expect(prompt).toContain("## Change 2");
    expect(prompt).toContain("- Route: `/pricing`");
    expect(prompt).toContain('<section class="hero">Hi</section>');
    expect(prompt).toContain("> make the hero bigger");
    expect(prompt).toContain("> blue button");
    expect(prompt).toContain("- Ancestors: `body > div#root > main.container`");
  });

  it("quotes every line of a multi-line prompt", () => {
    const prompt = buildDesignPrompt(
      [stage({ prompt: "bigger\nand bolder" })],
      "http://localhost:5173/",
    );

    expect(prompt).toContain("> bigger\n> and bolder");
  });

  it("omits the ancestor line when the element has no ancestors", () => {
    const prompt = buildDesignPrompt([stage({ ancestors: "" })], "http://localhost:5173/");

    expect(prompt).not.toContain("- Ancestors:");
  });
});
