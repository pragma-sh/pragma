import { converter, formatHex } from "culori";

const toRgb = converter("rgb");
const toOklch = converter("oklch");

/**
 * Plugin agent icons are brand assets: some are near-black glyphs (Grok), some
 * near-white (opencode), some mid-tone colour (Claude). Any monochrome one
 * disappears against a background of the same end of the scale, and the phone
 * follows the host theme, so either end can happen. The desktop samples the
 * rendered pixels on a canvas and inverts; React Native has no canvas, so this
 * module classifies an icon from its own bytes instead.
 *
 * An SVG is repainted: every colour it declares is flipped to its lightness
 * complement, which turns a black mark white (and back) while keeping the hue,
 * so a brand colour stays recognisable. A raster mark's pixels cannot be
 * classified or repainted here, so it keeps the neutral backdrop instead.
 */

/** Minimum WCAG contrast ratio for non-text graphics (AA). */
const MIN_CONTRAST_RATIO = 3;

/**
 * The backdrop's own luminance, chosen to clear {@link MIN_CONTRAST_RATIO}
 * against *both* pure black (5.3:1) and pure white (4.0:1) — so it rescues an
 * icon at either end without knowing which end it is.
 */
export const ICON_BACKDROP_COLOR = "#808080";

/** Linearize one gamma-encoded sRGB channel (0–1) to its light value. */
function linearizeChannel(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Perceived relative luminance (0 = black … 1 = white) of a CSS color. */
export function colorLuminance(value: string): number | null {
  const rgb = toRgb(value.trim());
  if (!rgb) return null;
  return (
    0.2126 * linearizeChannel(rgb.r) +
    0.7152 * linearizeChannel(rgb.g) +
    0.0722 * linearizeChannel(rgb.b)
  );
}

/** WCAG contrast ratio (1–21) between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every colour literal an SVG paints with: `fill=`/`stroke=` and their CSS twins. */
const PAINT_PATTERN = /(?:fill|stroke)\s*[:=]\s*["']?\s*([^"';)>]+)/gi;

/**
 * Average luminance of the colours an SVG paints with, or `null` when it
 * declares none we can read (only `currentColor`, gradients, or an empty
 * document). Non-colours — `none`, `url(#…)`, `currentColor`, `inherit` — are
 * skipped rather than guessed at.
 */
export function svgLuminance(xml: string): number | null {
  let total = 0;
  let count = 0;
  for (const match of xml.matchAll(PAINT_PATTERN)) {
    const luminance = paintLuminance(match[1] ?? "");
    if (luminance === null) continue;
    total += luminance;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

function paintLuminance(paint: string): number | null {
  const value = paint.trim();
  if (!value || /^(?:none|inherit|currentcolor|transparent|url\()/i.test(value)) return null;
  return colorLuminance(value);
}

/**
 * Whether an icon of the given luminance needs the neutral backdrop to stay
 * readable on a background of `backgroundLuminance`. Used for assets this
 * module cannot repaint — raster marks, whose pixels it never classifies.
 */
export function needsIconBackdrop(
  iconLuminance: number | null,
  backgroundLuminance: number | null,
): boolean {
  if (iconLuminance === null) return true;
  if (backgroundLuminance === null) return false;
  return contrastRatio(iconLuminance, backgroundLuminance) < MIN_CONTRAST_RATIO;
}

/** Same paint pattern, split so a rewrite can keep the `fill="` prefix intact. */
const PAINT_REWRITE_PATTERN = /((?:fill|stroke)\s*[:=]\s*["']?\s*)([^"';)>]+)/gi;

/**
 * A colour's lightness complement: the same hue and chroma at the opposite end
 * of the lightness scale. Black becomes white and a dark brand colour becomes a
 * light one *of the same hue*, which a flat RGB inversion (orange → blue) would
 * not preserve. Returns `null` for anything that is not a readable colour.
 */
export function invertLightness(color: string): string | null {
  const oklch = toOklch(color.trim());
  if (!oklch) return null;
  return formatHex({ ...oklch, l: 1 - oklch.l });
}

/** Repaints every colour an SVG declares with its {@link invertLightness}. */
export function invertSvgPaints(xml: string): string {
  return xml.replace(PAINT_REWRITE_PATTERN, (match, prefix: string, paint: string) => {
    const trimmed = paint.trim();
    if (paintLuminance(trimmed) === null) return match;
    const inverted = invertLightness(trimmed);
    return inverted === null ? match : `${prefix}${inverted}`;
  });
}

/**
 * The SVG to render on a background of `backgroundLuminance`: the original when
 * it already clears {@link MIN_CONTRAST_RATIO}, otherwise one repainted at the
 * opposite lightness. The inverted copy is only used when it actually reads
 * better, so an icon we cannot rescue is left as its designer drew it.
 */
export function svgForBackground(xml: string, backgroundLuminance: number | null): string {
  const luminance = svgLuminance(xml);
  if (luminance === null || backgroundLuminance === null) return xml;
  if (contrastRatio(luminance, backgroundLuminance) >= MIN_CONTRAST_RATIO) return xml;
  const inverted = invertSvgPaints(xml);
  const invertedLuminance = svgLuminance(inverted);
  if (invertedLuminance === null) return xml;
  const gained = contrastRatio(invertedLuminance, backgroundLuminance);
  return gained > contrastRatio(luminance, backgroundLuminance) ? inverted : xml;
}
