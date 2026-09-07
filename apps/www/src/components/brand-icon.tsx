import type { ComponentProps } from "react";

import {
  CANVAS,
  DARK_PLATE,
  LIGHT_PLATE,
  markMarkup,
  type MarkPalette,
  ON_DARK,
  ON_LIGHT,
} from "@pragma/brand";

/** Corner radius on the 1024 canvas, matching `faviconLayer`'s plate. */
const PLATE_RADIUS = 224;

/** The desktop app icon's full mark + gradient plate, rounded for the web. */
function plateLayer(
  plate: readonly [string, string, string],
  palette: MarkPalette,
  idPrefix: string,
): string {
  return `<defs>
    <linearGradient id="${idPrefix}-plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${plate[0]}" />
      <stop offset="0.55" stop-color="${plate[1]}" />
      <stop offset="1" stop-color="${plate[2]}" />
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="${PLATE_RADIUS}" fill="url(#${idPrefix}-plate)" />
  ${markMarkup(palette, { idPrefix })}`;
}

const lightModeMarkup = plateLayer(DARK_PLATE, ON_DARK, "brand-icon-light");
const darkModeMarkup = plateLayer(LIGHT_PLATE, ON_LIGHT, "brand-icon-dark");

/**
 * The desktop app icon, swapped for contrast: a dark plate in light mode, a
 * light plate in dark mode. The `(home)` route group is always `.dark`;
 * `/docs` toggles it.
 */
export function BrandIcon(props: ComponentProps<"svg">) {
  return (
    <svg viewBox={`0 0 ${CANVAS} ${CANVAS}`} aria-hidden="true" focusable="false" {...props}>
      <g className="dark:hidden" dangerouslySetInnerHTML={{ __html: lightModeMarkup }} />
      <g className="hidden dark:block" dangerouslySetInnerHTML={{ __html: darkModeMarkup }} />
    </svg>
  );
}
