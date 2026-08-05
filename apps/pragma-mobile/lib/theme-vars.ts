/**
 * Converts the desktop's `.pragma/theme.json` overrides into NativeWind theme
 * variables, so every `bg-background` / `text-foreground` class on this app
 * mirrors the user's desktop colors.
 *
 * Two boundaries are crossed here:
 *
 * - **Token catalog.** The desktop's token set is larger than this app's (it
 *   has a sidebar, a canvas, diff colors). Only the tokens declared in
 *   `global.css` are honoured; the rest are ignored rather than an error, so a
 *   theme written by a newer desktop still themes what this app renders.
 * - **Color space.** Desktop themes are written in `oklch(...)`, while
 *   `tailwind.config.js` wraps every variable as `hsl(var(--token))`. Each
 *   override is therefore converted to the bare `H S% L%` channel triple that
 *   form expects. Alpha is dropped: the `hsl(var(--x))` wrapper has nowhere to
 *   put it.
 */

import type { HostTheme } from "@pragma/sdk";
import { converter, type Rgb } from "culori";

const toRgb = converter("rgb");
const toHsl = converter("hsl");

/**
 * The tokens this app declares in `global.css`. Names match the desktop's own
 * token names, which is what makes the mirror a straight pass-through — keep
 * this list in step with `global.css`.
 */
const MOBILE_THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "border",
  "input",
  "ring",
] as const;

/** Color overrides for one scheme, keyed by desktop token name. */
export type ThemeOverrides = Partial<Record<string, string>>;

function round(value: number, digits: number): number {
  return Number.parseFloat(value.toFixed(digits));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Clamps to sRGB and snaps each channel to 8-bit precision — the precision the
 * device actually renders. Without the snap, conversion noise of ~1e-6 in a
 * near-grey turns into a hue and a saturation of tens of percent.
 */
function clampToSrgb(color: Rgb): Rgb {
  const channel = (value: number) => Math.round(clamp01(value) * 255) / 255;
  return {
    mode: "rgb",
    r: channel(color.r),
    g: channel(color.g),
    b: channel(color.b),
    alpha: color.alpha,
  };
}

/**
 * Converts any CSS color the desktop may have written to the `H S% L%` channel
 * triple `hsl(var(--token))` expects. Returns `null` when the value is not a
 * color, so a hand-edited theme file cannot inject garbage into a style.
 */
export function hslChannels(value: string): string | null {
  const rgb = toRgb(value.trim());
  if (!rgb) return null;
  // Clamp through sRGB first. A wide-gamut `oklch(...)` — and even a plain
  // `oklch(1 0 0)`, whose round-trip lands a hair above 1 — otherwise reaches
  // `hsl` out of gamut, where white comes back as a saturated hue.
  const color = toHsl(clampToSrgb(rgb));
  if (!color) return null;
  const hue = round(color.h ?? 0, 2);
  const saturation = round((color.s ?? 0) * 100, 2);
  const lightness = round((color.l ?? 0) * 100, 2);
  return `${hue} ${saturation}% ${lightness}%`;
}

/** A ready-to-use `hsl(...)` string for native props that take a color. */
export function themeColor(value: string): string | null {
  const channels = hslChannels(value);
  return channels === null ? null : `hsl(${channels})`;
}

/**
 * Stable identity for a fetched host theme, so a poll that returns the same
 * colors can be dropped instead of re-rendering every themed screen. Only
 * `colors` is compared: which scopes contributed is not a visual difference.
 */
export function themeKey(theme: HostTheme): string {
  return JSON.stringify(theme.colors ?? {});
}

/**
 * Builds the NativeWind variable map for one scheme's overrides. Unknown tokens
 * and unparseable colors are dropped, so what is left always renders.
 */
export function themeVars(overrides: ThemeOverrides | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!overrides) return vars;
  for (const token of MOBILE_THEME_TOKENS) {
    const value = overrides[token];
    if (!value) continue;
    const channels = hslChannels(value);
    if (channels !== null) vars[`--${token}`] = channels;
  }
  return vars;
}
