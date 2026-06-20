import { useEffect, useState } from "react";

/**
 * Relative luminance of the tab-strip chrome the icons sit on (`#151b24`, see
 * `TerminalTabs`). Contrast is measured against this, not against pure black.
 */
const CHROME_LUMINANCE = relativeLuminance(0x15, 0x1b, 0x24);

/**
 * Minimum WCAG contrast ratio an icon must clear against the chrome before we
 * leave it untouched. 3:1 is the AA bar for non-text graphics/UI components — a
 * black glyph (~1.2:1) is inverted, while a mid-tone colored logo (Claude orange
 * is ~5:1) comfortably clears it and keeps its color.
 */
const MIN_CONTRAST_RATIO = 3;

/** Offscreen sample size; icons are tiny, so a 16×16 grid is plenty to classify. */
const SAMPLE_SIZE = 16;

/** Linearize one gamma-encoded sRGB channel (0–255) to its 0–1 light value. */
function linearizeChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Perceived relative luminance (0 = black … 1 = white) of an sRGB color. */
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/**
 * Alpha-weighted average luminance of the opaque pixels in an RGBA buffer.
 * Fully transparent pixels are ignored so padding around a glyph does not skew
 * the result. Returns `1` (treat as light) when there is nothing opaque to read.
 */
export function averageOpaqueLuminance(data: Uint8ClampedArray): number {
  let total = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = (data[i + 3] ?? 0) / 255;
    if (alpha === 0) {
      continue;
    }
    total += relativeLuminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) * alpha;
    weight += alpha;
  }
  return weight > 0 ? total / weight : 1;
}

/** WCAG contrast ratio (1–21) between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether an icon of the given average luminance is too low-contrast against the
 * chrome to read, and therefore needs inverting. Exported for testing.
 */
export function needsInvertForLuminance(luminance: number): boolean {
  return contrastRatio(luminance, CHROME_LUMINANCE) < MIN_CONTRAST_RATIO;
}

const INVERT_CACHE = new Map<string, boolean>();

/**
 * Decide whether an icon needs CSS `invert` to stay legible on Pragma's dark
 * chrome. The image is sampled once (results are cached per source); the icon is
 * inverted **only** when its opaque pixels are too dark to contrast the
 * background. Light or colored icons are left untouched.
 */
export function useIconNeedsInvert(src: string | null | undefined): boolean {
  const [needsInvert, setNeedsInvert] = useState<boolean>(() =>
    src ? (INVERT_CACHE.get(src) ?? false) : false,
  );

  useEffect(() => {
    if (!src) {
      setNeedsInvert(false);
      return;
    }
    const cached = INVERT_CACHE.get(src);
    if (cached !== undefined) {
      setNeedsInvert(cached);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.addEventListener("load", () => {
      if (cancelled) {
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          return;
        }
        ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const result = needsInvertForLuminance(averageOpaqueLuminance(data));
        INVERT_CACHE.set(src, result);
        setNeedsInvert(result);
      } catch {
        // Canvas read failed (should not happen for same-origin data URLs); leave as-is.
      }
    });
    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  return needsInvert;
}
