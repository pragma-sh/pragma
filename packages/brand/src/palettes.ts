// The Pragma mark's colour treatments.
//
// Geometry lives in `mark.ts`; this file says how it is painted. These are
// brand decisions, not platform ones — which slot uses which treatment is up
// to the consumer (see `apps/pragma-go/scripts/icon-variants.ts`).

import type { MarkPalette } from "./mark";

/**
 * Plate colours behind the mark: top, middle, bottom.
 *
 * The desktop icon's plate is a **vertical** fade, not a diagonal one. Sampled
 * down its left and right edges it falls monotonically from about `#1e1e1e` at
 * the top to `#090909` at the bottom, with a slight extra darkening toward the
 * right. Ours runs a little deeper so the plate reads as black rather than as
 * dark grey.
 */
export const DARK_PLATE = ["#1c1c1e", "#0e0e10", "#030304"] as const;
export const LIGHT_PLATE = ["#ffffff", "#fdfdfe", "#f2f2f6"] as const;
export const TINTED_PLATE = ["#2e2e2e", "#191919", "#000000"] as const;

/** Ink colours. `#0b0b0c` is the splash background the dark theme already uses. */
export const INK = "#0b0b0c";

/** The brand treatment: white mark on a black plate, as on the desktop app. */
export const ON_DARK: MarkPalette = {
  stroke: "#ffffff",
  fill: "#101013",
  cardStroke: "#71717a",
  cardStrokeFar: "#46464d",
  cardFill: "#0b0b0d",
  cardFillFar: "#08080a",
  detail: "#ffffff",
};

/**
 * The mark inverted, for a light plate.
 *
 * The card strokes are contrast-matched to the dark treatment rather than
 * picked by eye. On the dark plate the nearer card sits at about 3.5:1 against
 * its background and the farther one at 2.1:1; the obvious light-mode
 * equivalents (pale greys) come out far below that and the stack disappears.
 * These are the greys that hold the same ratios against white.
 */
export const ON_LIGHT: MarkPalette = {
  stroke: INK,
  fill: "#ffffff",
  cardStroke: "#5c5c66",
  cardStrokeFar: "#8b8b97",
  cardFill: "#ffffff",
  cardFillFar: "#fbfbfd",
  detail: INK,
};

/** Transparent-plate treatment: the system supplies the backdrop. */
export const ON_TRANSPARENT: MarkPalette = {
  stroke: "#ffffff",
  fill: "rgba(255,255,255,0.06)",
  cardStroke: "rgba(255,255,255,0.5)",
  cardStrokeFar: "rgba(255,255,255,0.3)",
  cardFill: "rgba(255,255,255,0.04)",
  cardFillFar: "rgba(255,255,255,0.03)",
  detail: "#ffffff",
};

/** Greyscale: iOS reads luminance as tint strength, so the plate stays dark. */
export const TINTED: MarkPalette = {
  stroke: "#ffffff",
  fill: "none",
  cardStroke: "#9d9d9d",
  cardStrokeFar: "#5e5e5e",
  cardFill: "none",
  cardFillFar: "none",
  detail: "#ffffff",
};

/** Single-colour, unfilled: Android keeps only the alpha channel. */
export const MONOCHROME: MarkPalette = {
  stroke: "#ffffff",
  fill: "none",
  cardStroke: "rgba(255,255,255,0.55)",
  cardStrokeFar: "rgba(255,255,255,0.32)",
  cardFill: "none",
  cardFillFar: "none",
  detail: "#ffffff",
};
