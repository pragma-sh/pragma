import { describe, expect, it } from "vitest";

import { buildScratchpadViewerHtml, scratchpadThemeCss } from "./html";

describe("buildScratchpadViewerHtml", () => {
  it("inlines the source and comments, and nothing external", () => {
    const html = buildScratchpadViewerHtml({
      source: "# Plan\n",
      comments: [
        { id: "a", from: 0, to: 0, quote: "Plan", text: "why", createdAt: 1, resolvedAt: null },
      ],
      mode: "dark",
    });

    expect(html).toContain('<html class="dark"');
    expect(html).toContain("pragmaScratchpadSource");
    expect(html).toContain('"quote":"Plan"');
    expect(html).not.toMatch(/src="https?:/);
  });

  it("neutralizes a document that closes the script element", () => {
    const html = buildScratchpadViewerHtml({ source: "</script><script>alert(1)</script>" });

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("gives the page a randomUUID, since an origin-less document has none", () => {
    const html = buildScratchpadViewerHtml({ source: "# Plan\n" });

    expect(html).toContain('Object.defineProperty(crypto,"randomUUID"');
    expect(html.indexOf("randomUUID")).toBeLessThan(html.indexOf("pragmaScratchpadSource"));
  });

  it("emits only well-formed theme overrides", () => {
    const css = scratchpadThemeCss({
      card: "oklch(0.2 0 0)",
      "muted-foreground": "oklch(0.7 0 0)",
      "bad;token": "red",
      injected: "red;} body{display:none",
    });

    expect(css).toBe(":root{--card: oklch(0.2 0 0);--muted-foreground: oklch(0.7 0 0);}");
  });

  it("emits nothing when the host has no overrides", () => {
    expect(scratchpadThemeCss({})).toBe("");
  });
});
