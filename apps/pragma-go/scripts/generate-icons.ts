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

import { faviconSvg, indexHtml, PNG_VARIANTS } from "./icon-variants";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = join(appDir, "assets", "images");
const publicDir = join(appDir, "public");

mkdirSync(imagesDir, { recursive: true });
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
