// The Pragma mark, as vector geometry.
//
// The desktop app ships only rasterised icons (`apps/pragma/src-tauri/icons`),
// so this module is the vector redraw of that artwork and the single source of
// truth for every rendered Pragma icon. It emits SVG markup as strings and has
// no dependencies, so any consumer — a build script, a docs page, a preview —
// can render it however it likes.
//
// Geometry lives in a 1024x1024 design space. The mark itself occupies
// `MARK_BOUNDS` inside it, so a variant can centre and scale it without
// re-deriving coordinates.

/**
 * The box the drawn mark occupies in the 1024 design space.
 *
 * It is *not* centred: the desktop icon sits a touch right of centre, because
 * the bold "P" is left-heavy and the faint cards balance it. The plated icons
 * draw at these authored coordinates rather than re-centring, so that
 * composition survives.
 */
const MARK_BOUNDS = { x: 161, y: 146, width: 739, height: 737 };

/** Edge length of the design space every path below is expressed in. */
export const CANVAS = 1024;

/** How the strokes and fills of one variant are coloured. */
export interface MarkPalette {
  /** Stroke of the front terminal window (the bowl and stem of the "P"). */
  stroke: string;
  /** Fill behind the front window, hiding the stacked cards it overlaps. */
  fill: string;
  /** Stroke of the nearer stacked card. */
  cardStroke: string;
  /** Stroke of the farther stacked card. */
  cardStrokeFar: string;
  /** Fill of the nearer stacked card. */
  cardFill: string;
  /** Fill of the farther stacked card. */
  cardFillFar: string;
  /** The `>_` prompt and the text rules. */
  detail: string;
}

/**
 * The outline of the terminal window that forms the "P", plus the rule that
 * divides its bowl from its stem.
 *
 * The bowl is a **rounded rectangle**, not a semicircular cap: traced off the
 * desktop icon, its right edge runs straight for ~60 units between corners of
 * radius 157. A semicircle here is the single most visible way to get this
 * mark wrong. The divider is a second subpath — it runs the full width, from
 * the left edge across to the bowl's bottom-right curve, so the stem's right
 * edge meets it as a T rather than closing a corner. A zero-area subpath adds
 * nothing to the fill, so the shape still fills correctly.
 */
const WINDOW_PATH =
  "M 223 157 L 562 157 A 157 157 0 0 1 719 314 L 719 375 A 157 157 0 0 1 562 532 " +
  "L 418 532 L 418 820 A 52 52 0 0 1 366 872 L 224 872 A 52 52 0 0 1 172 820 " +
  "L 172 208 A 51 51 0 0 1 223 157 Z M 172 532 L 418 532";

/** The `>_` prompt inside the bowl. */
const PROMPT_PATHS = ["M 256 250 L 352 307 L 256 371", "M 365 367 L 448 367"];

/** Text rules inside the stem of the "P". */
const STEM_RULES = [
  "M 234 694 L 326 694",
  "M 236 740 L 260 740",
  "M 283 740 L 352 740",
  "M 237 773 L 275 773",
];

/** Text rules on the nearer stacked card, right of the stem. */
const CARD_RULES = ["M 477 694 L 602 694", "M 477 740 L 508 740", "M 530 740 L 631 740"];

/**
 * The two windows stacked behind the front one, back to front.
 *
 * They are near-square and step down-and-right in equal measure — about +88
 * across and +73 down per card, traced off the desktop icon. Cards that are
 * too small, or offset mostly sideways, make the stack read as rising to the
 * right instead of receding down the page.
 */
const CARDS = [
  { x: 345, y: 313, width: 547, height: 545 },
  { x: 256, y: 240, width: 547, height: 545 },
];

const CARD_RADIUS = 69;
const WINDOW_STROKE = 22;
const CARD_STROKE = 17;
const PROMPT_STROKE = 24;
const RULE_STROKE = 15;

/**
 * The mark as SVG markup, in the 1024 design space.
 *
 * `cards` draws the two stacked windows behind the front one; a favicon drops
 * them because they turn to noise below ~32px. `idPrefix` namespaces the mask
 * so several marks can share one document.
 */
export function markMarkup(
  palette: MarkPalette,
  {
    cards = true,
    idPrefix = "mark",
    strokeScale = 1,
  }: { cards?: boolean; idPrefix?: string; strokeScale?: number } = {},
): string {
  const parts: string[] = [];
  const round = `stroke-linecap="round" stroke-linejoin="round"`;
  const w = (base: number) => +(base * strokeScale).toFixed(2);

  if (cards) {
    // The stacked windows sit *behind* the front one, so they must not show
    // through it. An opaque fill would do that on the plated variants, but the
    // dark, tinted, and monochrome appearances draw the front window unfilled —
    // so punch its silhouette (body plus stroke) out of the cards instead.
    const maskId = `${idPrefix}-occlude`;
    parts.push(
      `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}">` +
        `<rect width="${CANVAS}" height="${CANVAS}" fill="#fff"/>` +
        `<path d="${WINDOW_PATH}" fill="#000" stroke="#000" stroke-width="${w(WINDOW_STROKE)}" ${round}/>` +
        `</mask>`,
    );
    const fills = [palette.cardFillFar, palette.cardFill];
    const strokes = [palette.cardStrokeFar, palette.cardStroke];
    const cardParts: string[] = [];
    CARDS.forEach((card, index) => {
      cardParts.push(
        `<rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" ` +
          `rx="${CARD_RADIUS}" fill="${fills[index]}" stroke="${strokes[index]}" ` +
          `stroke-width="${w(CARD_STROKE)}"/>`,
      );
      if (index === 1) {
        for (const rule of CARD_RULES) {
          cardParts.push(
            `<path d="${rule}" stroke="${strokes[index]}" stroke-width="${w(RULE_STROKE)}" ${round} fill="none"/>`,
          );
        }
      }
    });
    parts.push(`<g mask="url(#${maskId})">${cardParts.join("")}</g>`);
  }

  parts.push(
    `<path d="${WINDOW_PATH}" fill="${palette.fill}" stroke="${palette.stroke}" ` +
      `stroke-width="${w(WINDOW_STROKE)}" ${round}/>`,
  );
  for (const prompt of PROMPT_PATHS) {
    parts.push(
      `<path d="${prompt}" stroke="${palette.detail}" stroke-width="${w(PROMPT_STROKE)}" ${round} fill="none"/>`,
    );
  }
  if (cards) {
    for (const rule of STEM_RULES) {
      parts.push(
        `<path d="${rule}" stroke="${palette.detail}" stroke-width="${w(RULE_STROKE)}" ${round} fill="none"/>`,
      );
    }
  }
  return parts.join("\n    ");
}

/**
 * Wraps the mark in a transform that centres it on `CANVAS` and scales it so
 * its longest side covers `coverage` of the canvas.
 */
export function placedMark(
  palette: MarkPalette,
  {
    coverage,
    cards = true,
    idPrefix,
    strokeScale,
  }: { coverage: number; cards?: boolean; idPrefix?: string; strokeScale?: number },
): string {
  const scale = (CANVAS * coverage) / Math.max(MARK_BOUNDS.width, MARK_BOUNDS.height);
  const cx = MARK_BOUNDS.x + MARK_BOUNDS.width / 2;
  const cy = MARK_BOUNDS.y + MARK_BOUNDS.height / 2;
  const tx = CANVAS / 2 - cx * scale;
  const ty = CANVAS / 2 - cy * scale;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${markMarkup(palette, { cards, idPrefix, strokeScale })}
  </g>`;
}
