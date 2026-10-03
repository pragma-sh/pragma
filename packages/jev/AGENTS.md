# @pragma-sh/jev — drive the running dev app

Private contributor tool, run from the root as `bun run jev -- <command>`. Not part of
`pragma-cli` and never shipped. It drives a **running, visible** `bun run dev` window
through the Tauri dev bridge, the way a person would. A Jev-powered agent loop
(`typesafe/jev-router` on OpenRouter) sits on top. Usage lives in the `jev` skill
(`.agents/skills/jev/SKILL.md`). This file covers internals.

## Layout

| Path                | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `src/cli.ts`        | Argument parsing and the command table                                           |
| `src/bridge.ts`     | Finds live bridges (`/tmp/tauri-dev-bridge-*.token`), picks one, `/eval`         |
| `src/page-agent.js` | Injected into the webview: snapshot, element index, pointer/keyboard/wheel input |
| `src/page.ts`       | Typed wrappers over the page agent, and the text render of a snapshot            |
| `src/keys.ts`       | Chord parsing (`Meta+Shift+p`) into `KeyboardEvent` fields, including `keyCode`  |
| `src/menu.ts`       | Routes chords bound to native menu items through the bridge's `/menu`            |
| `src/screenshot.ts` | Window capture (bridge `/screenshot`, OS tool fallback), window raise            |
| `src/model.ts`      | OpenRouter chat client and key lookup                                            |
| `src/prompt.ts`     | System prompt, per-step prompt, decision JSON schema                             |
| `src/agent.ts`      | The run loop, actions, and persisted sessions (`ask` → `--resume`)               |

## Design rules

- **Same transport as the old tauri-agent-tools: the dev bridge.** Debug builds start it
  (`lib.rs`). jev adds two endpoints of its own: `/screenshot` (the app captures its own
  window with `xcap`, so the _app's_ Screen Recording grant applies rather than the
  terminal's) and `/menu` (lists and fires native menu items; see below). Bump
  `BRIDGE_VERSION` when the HTTP surface changes.
- **Input is DOM events at real coordinates, never app internals.** `click` hit-tests the
  element's visible centre with `elementFromPoint` and dispatches pointerover … pointerdown,
  mousedown, focus, pointerup, mouseup, click, the same order a mouse produces. Text goes in
  through `execCommand("insertText")`, which produces the `input` events that React-controlled
  fields and xterm's helper textarea both accept.
- **The terminal is a canvas.** WebGL xterm leaves no text in the DOM. Text is read through
  the dev-only `constants.bench.hookGlobal` hook (shared with `packages/bench`). Typing
  reaches the shell by focusing `.xterm-helper-textarea`, which is what clicking the canvas
  does. Synthetic `KeyboardEvent`s get `keyCode`/`which` defined by hand, because
  constructors ignore them and xterm reads nothing else.
- **Native menu chords cannot be synthesised.** macOS gives ⌘T, ⌘W, ⌘P, ⌘⇧P, and ⌘, to the
  menu bar before WebKit sees them, and `use-shortcuts.ts` deliberately ignores those
  chords in the page. `menu.ts` matches a chord against the bridge's `/menu` list, built
  from `MENU_ACCELERATORS` in `lib.rs` (the single source), and fires the item instead.
- **Instance selection never guesses.** An explicit `--pid` wins. Otherwise jev uses the
  instance whose binary lives inside the current git checkout, then a lone instance. With
  several and no match, it errors. Stale token files are common (the bridge cannot clean up
  on SIGKILL), so a dead pid is skipped before any network call.
- **The page agent holds no closure state.** It is re-injected on every call. The element
  index from the last snapshot lives on `window.__JEV_PAGE_STATE__`, which is why
  `jev snapshot` followed by `jev click 12` works across processes.
- **The bridge caps one eval at 5 s.** Keep page-agent work bounded (`MAX_ELEMENTS`,
  `MAX_TEXTS`). A snapshot of the full workspace takes about 300 ms.
- **Jev routes to reasoning models.** Keep `max_tokens` generous (6000 by default). On
  `finish_reason: "length"` with no content, the request is retried once with double the
  budget.

## Testing

`bun run --filter @pragma-sh/jev test` covers the pure parts: keys, instance choice, menu
matching, decision parsing, snapshot rendering, key lookup. The page agent can only be
exercised meaningfully against a live dev window: `bun run jev -- snapshot`,
`terminal run`, `key Meta+t`, and a short `run`.
