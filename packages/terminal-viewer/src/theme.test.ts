import { describe, expect, it } from "vitest";

import { TERMINAL_FALLBACK_COLORS, TERMINAL_LIGHT_ANSI } from "./theme";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("TERMINAL_LIGHT_ANSI", () => {
  it("keeps every ANSI color legible on the light background", () => {
    const background = TERMINAL_FALLBACK_COLORS.light.background;
    for (const [name, color] of Object.entries(TERMINAL_LIGHT_ANSI)) {
      expect(contrast(color, background), name).toBeGreaterThanOrEqual(3);
    }
  });
});
