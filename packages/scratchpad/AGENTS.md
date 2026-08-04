# packages/scratchpad - @pragma/scratchpad

Browser-safe API bundled into agent-authored MDX scratchpads. Root re-exports
`@pragma/sdk` and adds scratchpad-host interaction. `ui` contains composed interactive
components; `ui/primitives` contains their small shadcn-compatible building blocks.

## Rules

- Runtime host access goes through `globalThis.pragmaScratchpad`; never import desktop internals.
- **Styling is one stylesheet, not inline styles.** `src/styles.ts` holds every `pragma-*`
  rule and `ensureScratchpadStyles()` injects it once per document; components only set
  class names. Inline styles cannot express hover/focus/disabled states or media queries,
  which is what made the old components look unfinished. Reserve the `style` prop for a
  per-instance CSS variable (e.g. `--pragma-tone`).
- **Colors, radii and fonts come from desktop theme variables only** — `var(--card)`,
  `var(--primary)`, `var(--radius-md)`, `var(--font-mono)`. The host injects the resolved
  values into the frame (`apps/pragma/src/lib/scratchpad-theme.ts`), so a theme override
  reaches these components with no work here. The literal fallback after each `var()`
  exists only for a scratchpad rendered outside Pragma; never treat it as the palette.
- **`AskQuestion` is one choice list for every shape.** `options` and `yes-no` render
  circular radios, `multi-select` renders checkboxes, and `text` is free text only; all
  three choice shapes submit through the same button rather than on click, because
  `allowOpenResponse` now appends an "Other" choice whose label is replaced in place by an
  input once selected, instead of a standing free-text field. That input lives inside the
  row's `<label>`, so its click must stop propagating or the row re-toggles itself. Selection logic lives in `src/question.ts` (DOM-free, so it is
  unit-tested); the component only wires it to native inputs.
- **`DiffReview` mirrors the desktop's `@codemirror/merge` view, without CodeMirror.**
  Scratchpads have no bundler in the frame, so `src/diff.ts` computes the alignment
  itself: equal lines face each other, an unpaired insert/delete faces a spacer (the
  `cm-mergeSpacer` equivalent), and a replaced line pair gets word-level segments (the
  `cm-changedText` equivalent). Its LCS table is capped at `MAX_DP_CELLS`; past that a
  differing region degrades to a wholesale replacement rather than stalling the frame.
- Keep components browser-safe and sandbox-safe. No Node APIs, Tauri APIs, storage, or direct parent access.
- `promptAgent` must preserve default missing-agent attachment behavior while allowing a per-call callback.
- Public functions, types, and components require JSDoc.
- React remains a peer dependency.
- Browser bundles must use the production JSX runtime, not `jsxDEV`; React's production
  `jsx-dev-runtime` intentionally leaves `jsxDEV` undefined. Keep bunup in the child
  process with startup `NODE_ENV=production` in `scripts/build.ts` until Bun honors
  `jsx.development: false` after startup.

## Commands

```bash
bun run --filter @pragma/scratchpad build
bun run --filter @pragma/scratchpad typecheck
bun run --filter @pragma/scratchpad test
```
