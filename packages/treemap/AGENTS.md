# `@pragma-sh/treemap`

GrandPerspective-style treemap geometry and colours: the squarified layout, the
fixed palette on black, and the cushion shading that gives every tile its edge.
Source of truth for how a Pragma treemap looks, wherever it is drawn.

The package is pure data and arithmetic, with no dependencies, no DOM and no
canvas. Consumers do the drawing:

- `apps/pragma` (Settings → Storage) paints tiles onto a `<canvas>` with
  `createLinearGradient`, feeding it `cushionStops`.
- `apps/www` (`src/lib/storage-cover.ts` + `/og/blog/storage-manager`) turns the
  same stops into CSS `linear-gradient`s for `next/og`, angled with
  `diagonalAngle` so they match the canvas gradient exactly.

## Files

| File              | Holds                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `src/squarify.ts` | `squarify` (Bruls, Huizing & van Wijk) and the `TreemapRect` / `TreemapItem` / `TreemapTile` types      |
| `src/palette.ts`  | `TREEMAP_PALETTE`, `TREEMAP_BACKGROUND`, `PROJECT_FRAME_COLOR`, `paletteColor`, `shade`, `cushionStops` |

## What belongs here, and what does not

- **Here:** anything that changes how a treemap _looks_ or is _laid out_, so the
  desktop and the website cannot drift apart.
- **Not here:** storage-scan types, zoom/hover state, or which node a click targets.
  Those belong to the desktop's `components/settings/storage/`.
- The palette deliberately ignores the app theme. Do not route it through
  `index.css` tokens.

## Commands

```bash
bun run --filter @pragma-sh/treemap test
bun run --filter @pragma-sh/treemap typecheck
```
