# packages/terminal-viewer — `@pragma/terminal-viewer`

A browser-safe terminal renderer: one self-contained HTML document running
xterm.js, plus the typed message protocol a native client drives it with.

## Why a document rather than a component

The renderer has to run where React Native cannot: inside a web view on a
phone, inside a sandboxed `<iframe>` on the web. Both load it from a **string**,
with no origin to resolve URLs against and no module loader — so xterm, its
addons, and its stylesheet are bundled into the document by `scripts/build.ts`
and inlined. Nothing is fetched at run time. A CDN would be an outage away from
a blank terminal, and a bundler dependency would make every embedding client
carry one.

## The protocol

`src/messages.ts` is the whole contract, and both directions are one-way JSON
over a string bridge. Everything crossing it is untrusted text:
`isTerminalViewerCommand` / `isTerminalViewerMessage` drop what they do not
recognise rather than partially applying it, and `terminalCommandScript`
embeds a command as a **string literal** the document parses itself — terminal
output ends up inside these payloads, and it is not source code.

Two details carry the design:

- **Output is base64, never a string.** Terminal output is bytes, and a
  multi-byte character split across two chunks is mangled by decoding each half
  alone. The renderer hands the bytes to xterm's own byte-aware writer.
- **`written` is backpressure, not telemetry.** It fires when the parser has
  consumed the bytes, so a host can bound how much it sends a phone that cannot
  keep up. Never treat a `write` as delivered when it is merely queued.

## Rules

- **The renderer never navigates and never opens a link itself.** A `link`
  message asks the host to; the host decides, and only on a real activation.
  Output from a program the user is only watching must not move the view.
- **Only the four `terminal-*` tokens reach the document's CSS**, and only as
  colour literals — `terminalThemeCss` is writing into a `<style>` element.
  xterm reads its palette from options, not CSS, so the runtime pushes the
  resolved colours into the terminal; a `var()` never reaches the canvas.
- **Do not add `@xterm/addon-attach`.** It assumes a WebSocket; Pragma's
  transport is NDJSON over the authenticated gateway, and the host owns it.
- Keep the xterm versions in step with `apps/pragma`, so desktop and mobile
  parse the same escape sequences.
