# `@pragma/brand`

The Pragma mark as vector geometry, plus the colour treatments it is painted
in. Source of truth for every rendered Pragma icon.

The package emits **SVG markup as strings** and has no dependencies — no
rasteriser, no filesystem, no platform knowledge. Consumers decide what to do
with the markup: `apps/pragma-go/scripts/` rasterises it with `sharp` into the
Expo icon set, while website surfaces consume the shared compact favicon
treatment directly.

## Files

| File              | Holds                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| `src/mark.ts`     | Geometry in a 1024x1024 design space; `markMarkup`, `placedMark`                      |
| `src/palettes.ts` | `ON_DARK`, `ON_LIGHT`, `ON_TRANSPARENT`, `TINTED`, `MONOCHROME`, plate colours, `INK` |
| `src/favicon.ts`  | Shared compact favicon layer and theme-aware SVG document                             |

## What belongs here, and what does not

**Here:** the shape of the mark, and how it is coloured. Both are brand
decisions that should look the same wherever Pragma renders its icon.

**Not here:** which slots a platform has, what each slot requires, and how the
markup becomes a file. iOS appearance rules, the Android adaptive safe zone,
Expo's `removeTransparency` behaviour, and the web shell all live with the app
that ships them (`apps/pragma-go/scripts/icon-variants.ts`). The compact favicon
treatment is shared because both web clients render the same browser slot; each
consumer still owns how that SVG is served or embedded.

## The geometry was traced, not eyeballed

`src/mark.ts` is a redraw of `apps/pragma/src-tauri/icons/icon.png`, which
ships only as raster. Three measurements are easy to get wrong and all three
are glaring:

- **The bowl is a rounded rectangle, not a semicircular cap.** Its right edge
  runs straight for ~60 units between corners of radius 157. Fitting a circle
  to the traced edge gives wildly different radii at different heights; a
  rounded rectangle fits every sample.
- **The rule under the bowl runs the full width**, from the left edge across to
  the bowl's bottom-right curve, so the stem's right edge meets it as a T
  rather than closing a corner. It is a second subpath on `WINDOW_PATH`; being
  zero-area it does not affect the fill.
- **The stacked cards are near-square and step down-and-right in equal
  measure.** Cards that are too small, or offset mostly sideways, make the
  stack read as rising to the right instead of receding down the page.

If you re-trace, measure edge positions off the PNG rather than trusting a
redraw by eye.

## The plate fades vertically

Sampling the desktop icon down its left and right edges shows the plate falling
monotonically from about `#1e1e1e` at the top to `#090909` at the bottom, with
only a slight lean to the right. It is **not** a diagonal gradient and **not** a
corner vignette — both of those light the middle and make the plate read as
grey. `DARK_PLATE` is a three-stop vertical ramp that tracks the original's
profile and then keeps going deeper, so the plate reads as black.

`LIGHT_PLATE` is the mirror of that idea and deliberately **much** flatter —
white down to `#f2f2f6`, with no edge shading at all. An earlier version faded
harder and darkened the right edge; on a white plate that reads as dirty grey
rather than as depth.

## Light-mode card strokes are contrast-matched, not eyeballed

On the dark plate the nearer stacked card sits at roughly 3.5:1 against its
background and the farther one at 2.1:1. Inverting the mark by picking pale
greys drops both far below that and the stack vanishes. `ON_LIGHT` uses the
greys that hold the same ratios against white, which is why they look darker
than instinct suggests.

## Placement

`markMarkup` draws at the authored coordinates. Those are composed against a
full-bleed plate and sit slightly right of centre, because the bold "P" is
left-heavy and the faint cards balance it — so a plated icon should use
`markMarkup` directly and keep that composition.

`placedMark` re-centres and scales the mark to cover a given fraction of the
canvas. Use it only where a platform demands it: a launcher safe zone, or a
favicon that needs a heavier `strokeScale` to survive 16px.
