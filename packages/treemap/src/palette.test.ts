import { describe, expect, it } from "vitest";

import { cushionStops, paletteColor, shade, TREEMAP_PALETTE } from "./palette";

describe("paletteColor", () => {
  it("wraps slots past either end of the palette", () => {
    expect(paletteColor(0)).toBe(TREEMAP_PALETTE[0]);
    expect(paletteColor(TREEMAP_PALETTE.length)).toBe(TREEMAP_PALETTE[0]);
    expect(paletteColor(-1)).toBe(TREEMAP_PALETTE.at(-1));
  });
});

describe("shade", () => {
  it("mixes toward white or black by the given weight", () => {
    expect(shade("#808080", 1)).toBe("rgb(255, 255, 255)");
    expect(shade("#808080", -1)).toBe("rgb(0, 0, 0)");
    expect(shade("#000000", 0.5)).toBe("rgb(128, 128, 128)");
  });
});

describe("cushionStops", () => {
  it("runs from a highlight through the color to a shadow", () => {
    const stops = cushionStops("#3b8fe4");
    expect(stops.map((stop) => stop.offset)).toEqual([0, 0.45, 1]);
    expect(stops[1]?.color).toBe("#3b8fe4");
  });
});
