import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { CANVAS } from "@pragma/brand";

const imagesDir = join(import.meta.dirname, "..", "assets", "images");

/** Alpha above this counts as ink; anti-aliased edges fall below it. */
const INK_ALPHA = 24;

/**
 * The circle Android guarantees every launcher mask leaves visible: the middle
 * 66dp of the 108dp adaptive canvas.
 */
const SAFE_RADIUS = (CANVAS * 66) / 108 / 2;

async function alpha(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(join(imagesDir, file))
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** How far the furthest inked pixel sits from the centre of the canvas. */
async function inkRadius(file: string): Promise<number> {
  const { data, width, height } = await alpha(file);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  let furthest = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[y * width + x] ?? 0) <= INK_ALPHA) {
        continue;
      }
      furthest = Math.max(furthest, Math.hypot(x - cx, y - cy));
    }
  }
  return furthest;
}

describe("generated icons", () => {
  it.each([
    "icon.png",
    "icon-light.png",
    "icon-tinted.png",
    "adaptive-icon.png",
    "adaptive-icon-monochrome.png",
    "favicon.png",
  ])("%s is a square %dpx canvas", async (file) => {
    const { width, height } = await alpha(file);
    expect(width).toBe(CANVAS);
    expect(height).toBe(CANVAS);
  });

  it.each(["adaptive-icon.png", "adaptive-icon-monochrome.png"])(
    "%s keeps its ink inside the Android safe circle",
    async (file) => {
      expect(await inkRadius(file)).toBeLessThanOrEqual(SAFE_RADIUS);
    },
  );

  // Nothing plated may be transparent. Apple requires an opaque greyscale
  // image for the tinted appearance, and `@expo/prebuild-config` renders every
  // appearance except `dark` with `removeTransparency`, flattening onto
  // **white** — a white mark on a white plate is an invisible icon. Pragma's
  // dark variant carries its own black plate rather than letting the system
  // supply one, so it is opaque too.
  it.each(["icon.png", "icon-light.png", "icon-tinted.png"])("%s is fully opaque", async (file) => {
    const { data } = await alpha(file);
    expect(data.reduce((lowest, value) => Math.min(lowest, value), 255)).toBe(255);
  });

  // Only the Android foregrounds keep an alpha channel — the launcher draws
  // the background behind them.
  it.each(["adaptive-icon.png", "adaptive-icon-monochrome.png"])(
    "%s keeps its transparency",
    async (file) => {
      const { data } = await alpha(file);
      expect(data[0]).toBe(0);
    },
  );
});
