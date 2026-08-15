import { describe, expect, it } from "vitest";

import {
  colorLuminance,
  contrastRatio,
  invertLightness,
  invertSvgPaints,
  needsIconBackdrop,
  svgForBackground,
  svgLuminance,
} from "./icon-contrast";

const DARK_BACKGROUND = colorLuminance("hsl(240 10% 4%)");
const LIGHT_BACKGROUND = colorLuminance("hsl(0 0% 100%)");

describe("svgLuminance", () => {
  it("averages the colours an icon paints with", () => {
    expect(svgLuminance('<svg><path fill="#050505"/></svg>')).toBeLessThan(0.05);
    expect(svgLuminance("<svg><path fill='white'/></svg>")).toBeGreaterThan(0.9);
  });

  it("reads a CSS style declaration too", () => {
    expect(svgLuminance('<svg><path style="fill:#ffffff"/></svg>')).toBeGreaterThan(0.9);
  });

  it("ignores paints that name no colour", () => {
    expect(svgLuminance('<svg><path fill="none" stroke="currentColor"/></svg>')).toBeNull();
    expect(svgLuminance('<svg><path fill="url(#gradient)"/></svg>')).toBeNull();
  });
});

describe("needsIconBackdrop", () => {
  it("rescues a black glyph on a dark background", () => {
    expect(
      needsIconBackdrop(svgLuminance('<svg><path fill="#050505"/></svg>'), DARK_BACKGROUND),
    ).toBe(true);
  });

  it("rescues a white glyph on a light background", () => {
    expect(
      needsIconBackdrop(svgLuminance('<svg><path fill="#fff"/></svg>'), LIGHT_BACKGROUND),
    ).toBe(true);
  });

  it("leaves a mid-tone brand colour alone in either theme", () => {
    const claude = svgLuminance('<svg><path fill="#D97757"/></svg>');
    expect(needsIconBackdrop(claude, DARK_BACKGROUND)).toBe(false);
    expect(needsIconBackdrop(claude, LIGHT_BACKGROUND)).toBe(false);
  });

  it("backs an unclassifiable icon, since a raster mark is usually monochrome", () => {
    expect(needsIconBackdrop(null, DARK_BACKGROUND)).toBe(true);
  });
});

describe("invertLightness", () => {
  it("flips the ends of the lightness scale", () => {
    expect(colorLuminance(invertLightness("#000000")!)).toBeGreaterThan(0.9);
    expect(colorLuminance(invertLightness("#ffffff")!)).toBeLessThan(0.05);
  });

  it("keeps the hue of a brand colour", () => {
    const inverted = invertLightness("#D97757");
    expect(inverted).not.toBeNull();
    // Still warm: red stays the dominant channel after the flip.
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(inverted!.slice(at, at + 2), 16));
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
  });

  it("returns null for a non-colour", () => {
    expect(invertLightness("currentColor")).toBeNull();
  });
});

describe("invertSvgPaints", () => {
  it("repaints attribute and style colours, leaving non-colours alone", () => {
    const inverted = invertSvgPaints(
      '<svg><path fill="#000000" stroke="none"/><path style="fill:#000"/></svg>',
    );
    expect(svgLuminance(inverted)).toBeGreaterThan(0.9);
    expect(inverted).toContain('stroke="none"');
  });

  it("preserves the quoting around a rewritten paint", () => {
    expect(invertSvgPaints(`<svg><path fill='#ffffff'/></svg>`)).toMatch(/fill='#[0-9a-f]{6}'/);
  });
});

describe("svgForBackground", () => {
  it("inverts a black glyph on a dark background", () => {
    const inverted = svgForBackground('<svg><path fill="#050505"/></svg>', DARK_BACKGROUND);
    expect(contrastRatio(svgLuminance(inverted)!, DARK_BACKGROUND!)).toBeGreaterThanOrEqual(3);
  });

  it("inverts a white glyph on a light background", () => {
    const inverted = svgForBackground('<svg><path fill="#fff"/></svg>', LIGHT_BACKGROUND);
    expect(contrastRatio(svgLuminance(inverted)!, LIGHT_BACKGROUND!)).toBeGreaterThanOrEqual(3);
  });

  it("leaves an icon that already reads untouched", () => {
    const xml = '<svg><path fill="#D97757"/></svg>';
    expect(svgForBackground(xml, DARK_BACKGROUND)).toBe(xml);
    expect(svgForBackground(xml, LIGHT_BACKGROUND)).toBe(xml);
  });

  it("leaves a `currentColor` icon untouched, since the renderer themes it", () => {
    const xml = '<svg><path fill="currentColor"/></svg>';
    expect(svgForBackground(xml, DARK_BACKGROUND)).toBe(xml);
  });
});
