# packages/scratchpad-viewer — @pragma/scratchpad-viewer

Renders a managed scratchpad **read-only** in any web view.

The scratchpad **file contract** (frontmatter, agent attachment, comment
threads) lives in `@pragma/scratchpad-contract` — the SDK needs it and cannot
depend on this package. It is re-exported from this package's index, so an
existing `@pragma/scratchpad-viewer` import of `parseScratchpadDocument`,
`attachScratchpadAgent`, or the comment helpers keeps working.

`buildScratchpadViewerHtml({ source, comments, mode, themeCss })` returns one
self-contained HTML string. Today its consumer is `apps/pragma-mobile`
(`react-native-webview`); the desktop keeps its own editor and only imports the
contract helpers.

## Rules

- **The document is self-contained, always.** A web view loading HTML from a
  string has no origin to resolve a relative URL against, and a phone reading a
  scratchpad over a tunnel should not need a second round trip to paint. The
  runtime — React, the MDX compiler, and every `@pragma/scratchpad` component —
  is bundled by `scripts/build.ts` into `src/generated/runtime-script.ts` and
  inlined. Nothing is fetched.
- **esbuild bundles the runtime, not `Bun.build`.** Bun's Windows bundler panics
  ("Expected pretty file path to have only forward slashes") on `node_modules`
  paths outside the entry root, which is exactly what bundling the workspace
  deps does. See `packages/scratchpad/AGENTS.md`.
- **Stripped imports become page globals, not nothing.** `components` covers the
  capitalized tags MDX _renders_; it does not cover an identifier the document's
  own code _calls_. A scratchpad that defines a nested component
  (`import { useState } from "react"` + `export function Counter()`) compiles to
  a function body where `useState` is a free variable resolved against global
  scope — which is why dropping the import alone failed with
  "Can't find variable: useState". `installGlobalScope()` therefore publishes
  React (hooks included) and every `@pragma/scratchpad` export as globals before
  evaluating, minus a small reserved list (`location`, `top`, `name`, …) that a
  module export must never shadow. Add a new importable module to that function,
  not just to `componentScope()`.
- **MDX is evaluated, not compiled to a bundle.** `@mdx-js/mdx`'s `evaluate`
  runs in the page, so there is no esbuild-wasm and no network. The cost is that
  the document has **no module resolver**: `prepareMdxSource` strips frontmatter
  and every `import`, and the components those imports named are supplied to MDX
  as run-time components (`componentScope()`). A scratchpad that uses the
  shipped library renders exactly as it does on the desktop; one that imports a
  worktree file gets MDX's "Expected component X to be defined" error rendered
  in place by the error boundary, not a blank screen.
- **Do not restate the palette.** Every `@pragma/scratchpad` rule already carries
  a literal fallback after its `var()`. The host passes **overrides only**,
  through `scratchpadThemeCss`, and they are declared in one `:root` block the
  host can rewrite in place (`#pragma-scratchpad-theme`).
- **Comments are the desktop's file, in the desktop's shape** — see
  `packages/scratchpad-contract/AGENTS.md` for the shape itself. A comment
  written here lands in the same sibling `<file>.mdx.comments.json` and appears
  in the desktop's "Resolve comments" handoff.
- **The two message types are the contract.** `ScratchpadViewerMessage` (page →
  host) and `ScratchpadViewerCommand` (host → page) are imported by both ends,
  so a change on one side fails to typecheck on the other. Add to them rather
  than passing anything ad hoc through `postMessage`.
- **Comments and comment mode are pushed, never rebuilt.** Rebuilding the HTML
  remounts the document and throws away the reader's scroll position, so the
  host sends a `comments` / `commentMode` command instead.
- **Gestures live in the page, not the native host.** A tap selects a block; a
  press-and-hold previews the block a comment would land on and can be dragged
  before release. Touch handlers stay passive until the long press fires — until
  then, movement is the reader scrolling.
- **The bundled runtime is verified, not assumed.** `src/runtime/runtime.test.ts`
  boots the built script in jsdom and asserts the document renders, that a tap
  only selects in comment mode, and that an unrenderable document reports an
  error. It is the only way to test code that exists solely after the build.

## Commands

```bash
bun run --filter @pragma/scratchpad-viewer build      # runtime bundle + dist
bun run --filter @pragma/scratchpad-viewer typecheck
bun run --filter @pragma/scratchpad-viewer test
```
