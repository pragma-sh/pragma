/// <reference types="node" />

// Renders every Pragma Go icon from the vector mark in `icon-art.ts`, painted
// by the treatments in `icon-variants.ts`.
//
// Run with `bun run icons` after changing the artwork. The outputs are
// committed, because `expo prebuild` and `expo export` read them as plain
// files and neither the native builds nor CI run this script.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  faviconSvg,
  ICON_COMPOSER_SVGS,
  iconComposerJson,
  indexHtml,
  PNG_VARIANTS,
} from "./icon-variants";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = join(appDir, "assets", "images");
const iconComposerDir = join(appDir, "assets", "AppIcon.icon");
const iconComposerAssetsDir = join(iconComposerDir, "Assets");
const publicDir = join(appDir, "public");

mkdirSync(imagesDir, { recursive: true });
mkdirSync(iconComposerAssetsDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

await Promise.all(
  PNG_VARIANTS.map(async ({ file, svg }) => {
    const out = join(imagesDir, file);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
    console.log(`wrote ${out}`);
  }),
);

writeFileSync(join(publicDir, "favicon.svg"), faviconSvg());
console.log(`wrote ${join(publicDir, "favicon.svg")}`);
writeFileSync(join(publicDir, "index.html"), indexHtml());
console.log(`wrote ${join(publicDir, "index.html")}`);
writeFileSync(join(iconComposerDir, "icon.json"), iconComposerJson());
console.log(`wrote ${join(iconComposerDir, "icon.json")}`);
for (const { file, svg } of ICON_COMPOSER_SVGS) {
  writeFileSync(join(iconComposerAssetsDir, file), svg);
  console.log(`wrote ${join(iconComposerAssetsDir, file)}`);
}
