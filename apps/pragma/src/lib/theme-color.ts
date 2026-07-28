/**
 * Color conversions for the theme editor.
 *
 * Theme files are written in `oklch(...)` so every token in `.pragma/theme.json`
 * matches the shipped defaults in `index.css`. The shadcn color picker works in
 * sRGB, so this module is the single boundary that converts between the two.
 */

import { converter, type Rgb } from "culori";

const toOklch = converter("oklch");
const toRgb = converter("rgb");

/** An sRGB color as the color picker exchanges it: 0–255 channels, 0–1 alpha. */
export type Rgba = [number, number, number, number];

function round(value: number, digits: number): number {
  return Number.parseFloat(value.toFixed(digits));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Formats an oklch color the way `index.css` writes them: lightness and chroma
 * to three decimals, hue to two, and an `/ alpha` suffix only when translucent.
 */
function formatOklch(l: number, c: number, h: number, alpha = 1): string {
  const base = `oklch(${round(l, 3)} ${round(c, 3)} ${round(h, 2)}`;
  return alpha >= 1 ? `${base})` : `${base} / ${round(alpha, 3)})`;
}

/**
 * Converts a picker `[r, g, b, a]` tuple (0–255 channels) to an `oklch(...)`
 * string.
 */
export function rgbaToOklch([r, g, b, alpha]: Rgba): string {
  const source: Rgb = { mode: "rgb", r: r / 255, g: g / 255, b: b / 255, alpha };
  const color = toOklch(source);
  return formatOklch(color.l, color.c, color.h ?? 0, color.alpha ?? 1);
}

/**
 * Converts any CSS color to the picker's `[r, g, b, a]` tuple, clamping colors
 * that fall outside the sRGB gamut. Returns `null` when the input is not a color.
 */
export function cssColorToRgba(value: string): Rgba | null {
  const color = toRgb(value.trim());
  if (!color) return null;
  return [
    Math.round(clamp01(color.r) * 255),
    Math.round(clamp01(color.g) * 255),
    Math.round(clamp01(color.b) * 255),
    color.alpha ?? 1,
  ];
}

/** Reports whether a string parses as a CSS color. */
export function isCssColor(value: string): boolean {
  return toOklch(value.trim()) !== undefined;
}

/**
 * An `rgba(...)` string for the color picker's `defaultValue` — the picker
 * parses CSS strings but not oklch, and this form preserves alpha.
 */
export function cssColorToRgbaString(value: string): string | null {
  const rgba = cssColorToRgba(value);
  if (!rgba) return null;
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${round(rgba[3], 3)})`;
}
