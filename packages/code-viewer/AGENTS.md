# packages/code-viewer — `@pragma-sh/code-viewer`

Read-only code viewing shared by the desktop and Pragma Go. Two entry points:

- **`@pragma-sh/code-viewer`** (built to `dist/` by bunup) — `buildCodeViewerHtml`:
  one self-contained HTML document running CodeMirror over a file or a unified
  diff, plus the message contract and the palette a native client needs to paint
  its container before the document loads.
- **`@pragma-sh/code-viewer/codemirror`** (source) — the CodeMirror pieces the
  document is built from: the mode-aware base theme and highlight style, the
  grammar loader over `@codemirror/language-data`, and the unified diff
  (`unifiedDiffLines`, `unifiedDiffDocument`). The desktop editor imports these,
  so a file looks the same in a desktop tab and on a phone.

## Why a document rather than a component

Same reason as `@pragma-sh/terminal-viewer`: React Native cannot run CodeMirror,
and a web view loading a string has no origin and no module loader. The runtime
(`src/runtime/main.ts`) is bundled by `scripts/build.ts` with esbuild into one
inline IIFE — **every grammar in `language-data` included**, since there is no
network to lazy-load from. That makes the runtime ~1.6 MB (~540 KB gzipped), the
largest string a native client embeds; trimming it means curating the grammar
list in the runtime, not fetching anything at run time.

## Rules

- **Read-only is the contract.** The content is baked into the document when it
  is built, as a JSON `<script>` element with `<` escaped — inert data, never
  evaluated, and no file can close the element early. There is no command
  channel into the document; to show something else, build a new one.
- **The runtime must never import `src/html.ts`.** `html.ts` imports the
  generated runtime script, so the runtime would embed its own previous build.
  Shared constants the runtime needs live in `src/messages.ts` or `src/palette.ts`.
- **The dark palette is the desktop editor's.** Change a chrome color in
  `src/palette.ts`, not in the desktop's `codemirror-theme.ts`, which layers only
  desktop-specific extras (find highlights, inline review comments) on top.
- The renderer reports only `ready` and `error`; both are narrowed by
  `parseCodeViewerMessage` on the host side and anything else is dropped.
