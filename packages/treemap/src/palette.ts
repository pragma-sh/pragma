/**
 * GrandPerspective's "Bujumbura" palette, sampled from its screenshots. The
 * treemap deliberately does not follow any theme: like GrandPerspective, it is
 * a loud, fixed palette on black so adjacent folders are unmistakable.
 */
export const TREEMAP_PALETTE = [
  "#3b8fe4", // blue
  "#98c41c", // lime
  "#d8d43c", // yellow
  "#d5421b", // red
  "#e27b12", // orange
  "#d9a878", // tan
  "#6f5036", // brown
] as const;

/** The background every treemap is drawn on. */
export const TREEMAP_BACKGROUND = "#000";

/** The line around each project, drawn in the middle of its black gutter. */
export const PROJECT_FRAME_COLOR = "rgba(255, 255, 255, 0.75)";

/** The palette color for a slot, wrapping in both directions. */
export function paletteColor(slot: number): string {
  const size = TREEMAP_PALETTE.length;
  return TREEMAP_PALETTE[((slot % size) + size) % size] ?? TREEMAP_PALETTE[0];
}

/** Mixes a `#rrggbb` color toward white (`amount` > 0) or black (< 0). */
export function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const weight = Math.abs(amount);
  const channel = (shift: number) => {
    const base = (value >> shift) & 0xff;
    return Math.round(base + (target - base) * weight);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** One stop of a tile's diagonal gradient: a 0–1 offset and a CSS color. */
export interface CushionStop {
  offset: number;
  color: string;
}

/**
 * The cushion look: light falls from the top-left, so every tile runs from a
 * highlight in that corner through its color to a shadow at the bottom-right.
 * With no gaps between tiles, that shading is the only edge a tile has.
 */
export function cushionStops(color: string): readonly CushionStop[] {
  return [
    { offset: 0, color: shade(color, 0.55) },
    { offset: 0.45, color },
    { offset: 1, color: shade(color, -0.6) },
  ];
}
