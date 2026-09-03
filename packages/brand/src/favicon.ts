import { CANVAS, placedMark, type MarkPalette } from "./mark";
import { INK, ON_DARK } from "./palettes";

/** How much heavier favicon strokes are than app-icon strokes. */
const FAVICON_STROKE_SCALE = 1.9;

/** Places the simplified mark on one rounded favicon plate. */
export function faviconLayer(plate: string, ink: string, idPrefix: string): string {
  const palette: MarkPalette = {
    stroke: ink,
    fill: "none",
    cardStroke: ink,
    cardStrokeFar: ink,
    cardFill: "none",
    cardFillFar: "none",
    detail: ink,
  };

  return `<rect width="${CANVAS}" height="${CANVAS}" rx="224" fill="${plate}"/>
    ${placedMark(palette, {
      coverage: 0.7,
      cards: false,
      idPrefix,
      strokeScale: FAVICON_STROKE_SCALE,
    })}`;
}

/** Theme-aware browser favicon using the compact mark treatment. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
  <style>
    .dark { display: none }
    @media (prefers-color-scheme: dark) {
      .light { display: none }
      .dark { display: inline }
    }
  </style>
  <g class="light">${faviconLayer(INK, ON_DARK.stroke, "fav-light")}</g>
  <g class="dark">${faviconLayer(ON_DARK.stroke, INK, "fav-dark")}</g>
</svg>
`;
}
