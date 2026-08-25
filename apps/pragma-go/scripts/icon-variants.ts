// Which icon slots Pragma Go ships, and the SVG document behind each one.
//
// The mark and its colour treatments come from `@pragma/brand`; everything
// here is Expo- and platform-shaped — appearance slots, launcher safe zones,
// the web shell. `generate-icons.ts` rasterises the result.
//
// What each output is for:
//
//   assets/AppIcon.icon          iOS Icon Composer bundle. Its transparent
//                                vector layer receives Apple's system light,
//                                dark, tinted, and Liquid Glass treatments.
//   icon.png                     The black brand plate used by Android's legacy
//                                launcher icon and the stores.
//   adaptive-icon.png            Android adaptive foreground, transparent. Its
//                                coverage is set so the mark's outermost ink
//                                stays inside the 66/108dp circle every
//                                launcher mask leaves visible.
//   adaptive-icon-monochrome.png Android 13+ themed icons. Alpha is the only
//                                channel the system keeps.
//   favicon.png                  Source for the generated `/favicon.ico`.
//   public/favicon.svg           Browser tab icon that follows the OS theme.
//   public/index.html            Expo's web shell, with the favicon links and
//                                theme colours the shell cannot express.

import {
  CANVAS,
  DARK_PLATE,
  INK,
  type MarkPalette,
  markMarkup,
  MONOCHROME,
  ON_DARK,
  ON_LIGHT,
  ON_TRANSPARENT,
  placedMark,
} from "@pragma/brand";

/**
 * Coverage for the Android adaptive foreground.
 *
 * A launcher masks the 108dp canvas to a shape of its choosing, and only the
 * central 66dp is guaranteed to survive every one of them. The mark is nearly
 * square, so its corners sit much further from the centre than its edges do —
 * at the plate coverage a circular mask would take a corner off both the "P"
 * and the back card. This keeps the outermost ink inside that 66dp circle
 * (`icons.test.ts` checks it).
 */
const ADAPTIVE_COVERAGE = 0.455;

/**
 * A full-bleed square icon: iOS masks the corners itself.
 *
 * The plate fades **vertically**, top to bottom, which is what the desktop
 * icon does — sampling its edges shows a monotonic falloff down the canvas and
 * only a slight lean to the right. An earlier diagonal gradient under a corner
 * vignette lit the middle-left and read as grey rather than black.
 */
function plateSvg(
  plate: readonly [string, string, string],
  palette: MarkPalette,
  edgeOpacity = 0.22,
): string {
  const edge = "#000000";
  return svg(`
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${plate[0]}"/>
        <stop offset="0.55" stop-color="${plate[1]}"/>
        <stop offset="1" stop-color="${plate[2]}"/>
      </linearGradient>
      <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0.45" stop-color="${edge}" stop-opacity="0"/>
        <stop offset="1" stop-color="${edge}" stop-opacity="${edgeOpacity}"/>
      </linearGradient>
    </defs>
    <rect width="${CANVAS}" height="${CANVAS}" fill="url(#plate)"/>
    <rect width="${CANVAS}" height="${CANVAS}" fill="url(#edge)"/>
    ${markMarkup(palette)}
  `);
}

/**
 * A mark with no plate, re-centred and shrunk to a launcher's safe zone.
 *
 * Only Android needs this. The iOS variants keep the authored composition, so
 * light, dark, and tinted line up with one another and with the desktop icon.
 */
function safeZoneSvg(palette: MarkPalette): string {
  return svg(placedMark(palette, { coverage: ADAPTIVE_COVERAGE }));
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">${body}</svg>`;
}

/**
 * How much heavier the favicon's stroke is than the app icon's.
 *
 * At its authored weight the outline lands under half a pixel at 16px and
 * dissolves. 1.9x is the point where the bowl's counter still reads as a hole
 * at 16px but the mark is not yet a blob at 48px.
 */
const FAVICON_STROKE_SCALE = 1.9;

/**
 * Places the mark on the rounded plate a favicon uses.
 *
 * The stacked cards are dropped — they are the first thing to turn to noise —
 * but the window outline and its `>_` stay, so the tab icon reads as the same
 * mark as the app icon rather than as a bare letter.
 */
function faviconLayer(plate: string, ink: string, idPrefix: string): string {
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

/**
 * The tab icon, as a self-contained SVG that swaps ink with the OS theme.
 *
 * A rounded plate rather than a full-bleed square: browsers do not mask a
 * favicon, and a hard-edged square reads as a screenshot in a tab strip.
 */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
  <style>
    .dark { display: none }
    @media (prefers-color-scheme: dark) {
      .light { display: none }
      .dark { display: inline }
    }
  </style>
  <g class="light">${faviconLayer(INK, "#ffffff", "fav-light")}</g>
  <g class="dark">${faviconLayer("#ffffff", INK, "fav-dark")}</g>
</svg>
`;
}

/** The raster favicon Expo turns into `/favicon.ico`. */
function faviconPngSvg(): string {
  return svg(faviconLayer(INK, "#ffffff", "fav"));
}

/**
 * Expo's web shell.
 *
 * `web.favicon` only ever emits one `/favicon.ico`, so the theme-aware SVG and
 * the two `theme-color` meta tags have to be declared here. The SVG is inlined
 * as a `data:` URI on purpose: the bundle is served under a base path
 * (`/web`), and a relative `href` would resolve against the current route on a
 * deep-link reload.
 */
export function indexHtml(): string {
  const inline = encodeURIComponent(faviconSvg().replace(/\n\s*/g, " "));
  return `<!DOCTYPE html>
<!-- Generated by scripts/generate-icons.ts. Run \`bun run icons\` instead of editing. -->
<html lang="%LANG_ISO_CODE%">
  <head>
    <meta charset="utf-8" />
    <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
    <title>%WEB_TITLE%</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${inline}" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${INK}" />
    <!-- The \`react-native-web\` recommended style reset: https://necolas.github.io/react-native-web/docs/setup/#root-element -->
    <style id="expo-reset">
      /* These styles make the body full-height */
      html,
      body {
        height: 100%;
      }
      /* These styles disable body scrolling if you are using <ScrollView> */
      body {
        overflow: hidden;
      }
      /* These styles make the root element full-height */
      #root {
        display: flex;
        height: 100%;
        flex: 1;
      }
    </style>
  </head>

  <body>
    <!-- Use static rendering with Expo Router to support running without JavaScript. -->
    <noscript>
      You need to enable JavaScript to run this app.
    </noscript>
    <!-- The root element for your Expo app. -->
    <div id="root"></div>
  </body>
</html>
`;
}

/** Appearance artwork consumed by Apple's Icon Composer renderer. */
export const ICON_COMPOSER_SVGS = [
  { file: "mark-light.svg", svg: svg(markMarkup(ON_LIGHT, { idPrefix: "app-icon-light" })) },
  { file: "mark-dark.svg", svg: svg(markMarkup(ON_DARK, { idPrefix: "app-icon-dark" })) },
  { file: "mark-tinted.svg", svg: svg(markMarkup(MONOCHROME, { idPrefix: "app-icon-tinted" })) },
] as const;

/** Icon Composer document using Apple's native appearance backgrounds and effects. */
export function iconComposerJson(): string {
  return `${JSON.stringify(
    {
      "fill-specializations": [
        { value: "system-light" },
        { appearance: "dark", value: "system-dark" },
      ],
      groups: [
        {
          layers: [
            {
              "image-name": "mark-light.svg",
              "hidden-specializations": [
                { value: false },
                { appearance: "dark", value: true },
                { appearance: "tinted", value: true },
              ],
              glass: true,
              name: "Pragma mark light",
            },
            {
              "image-name": "mark-dark.svg",
              "hidden-specializations": [
                { value: true },
                { appearance: "dark", value: false },
                { appearance: "tinted", value: true },
              ],
              glass: true,
              name: "Pragma mark dark",
            },
            {
              "image-name": "mark-tinted.svg",
              "hidden-specializations": [
                { value: true },
                { appearance: "dark", value: true },
                { appearance: "tinted", value: false },
              ],
              glass: true,
              name: "Pragma mark tinted",
            },
          ],
          lighting: "combined",
          name: "Pragma mark",
          shadow: { kind: "neutral", opacity: 0.5 },
          specular: true,
          translucency: { enabled: true, value: 0.5 },
        },
      ],
      "supported-platforms": { squares: "shared" },
    },
    null,
    2,
  )}\n`;
}

/** Every PNG the app ships, as the SVG each is rendered from. */
export const PNG_VARIANTS: Array<{ file: string; svg: string }> = [
  { file: "icon.png", svg: plateSvg(DARK_PLATE, ON_DARK) },
  { file: "adaptive-icon.png", svg: safeZoneSvg(ON_TRANSPARENT) },
  { file: "adaptive-icon-monochrome.png", svg: safeZoneSvg(MONOCHROME) },
  { file: "favicon.png", svg: faviconPngSvg() },
];
