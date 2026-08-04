---
name: terminal-benchmark
description: Use when measuring or investigating perceived terminal lag in Pragma — typing latency, scroll smoothness, dropped frames — or when changing anything under packages/bench, the pragma-bench payloads, or the dev-only terminal bench hook. Covers running bun run benchmark, reading its report, and adding a scenario.
---

# Benchmark Pragma's Terminal

`@pragma/bench` answers one question: how long does it take for an input to show
up on screen. It launches a **real Pragma dev instance**, runs a ratatui payload
in a real terminal tab, and drives that window with real DOM events. Read
`packages/bench/AGENTS.md` before changing anything in it.

## Running

```bash
bun run benchmark                     # all scenarios, 10 tabs (1 measured, 9 load)
bun run benchmark -- --only typing --keystrokes 500
bun run benchmark -- --tabs 1         # idle window instead of a loaded one
bun run benchmark -- --tabs 20 --load-interval-ms 25   # heavier workspace
bun run benchmark -- --keep-open      # leave the window up to look at it
```

Needs `tauri-agent-tools` on `PATH`, macOS or Linux (the dev bridge writes its
token to a hard-coded `/tmp` path), and **no other dev server running** — Vite's
port is pinned, so quit any other `bun run dev` first. The first run compiles the
app; the launcher waits up to `--startup-timeout-secs` (default 900).

Output: an aligned table plus `bench-report.json` with every raw sample. There is
no pass/fail gate — compare a branch against `main` on the same idle machine, at
the same `--tabs`.

## One tab is measured, the rest are load

`--tabs` (default 10) counts the measured tab; the others run
`pragma-bench tui --auto-ms` (default 50ms) and repaint themselves for the whole
run. A single-terminal window is not the window anyone works in — background
agents' PTY traffic, IPC events, and xterm parsing land on the same threads as
the tab being typed into, so an idle-window number understates real lag.

- Only ever one tab is driven. Load tabs are opened (and waited for) **first**,
  the measured payload **last**, because `tabOpened` makes the newest tab active
  and only the tab in front is painted.
- Hidden tabs stay mounted and fed — `SplitHost` retains them, `flushOutput`
  writes regardless of visibility — so the load is real, not just server-side.
- The tab count is printed above the table and stored in `bench-report.json`.
  Runs at different `--tabs` are not comparable.
- After an app restart mid-run, recovery reopens the load tabs before the payload
  tab: a fresh document mounts only the active tab, so the old load tabs would be
  running with nothing attached.

## The three scenarios, and which one to believe

| Scenario        | Covers                                          |
| --------------- | ----------------------------------------------- |
| `typing`        | keydown → PTY → TUI redraw → xterm paint        |
| `scroll-tui`    | wheel → mouse report → TUI redraw → xterm paint |
| `scroll-buffer` | wheel → xterm scrollback → xterm paint          |

If `scroll-tui` regressed but `scroll-buffer` did not, the change is in the PTY
round-trip or in `TerminalManager`'s wheel pacing, not in the renderer. If both
moved, suspect the renderer or the webview.

`typing` is a **burst**: every keystroke is dispatched as fast as the page can
manage (`--typing-gap-ms`, `0` by default) and timed independently, so several
are in flight at once. Read its numbers as a queue draining while someone types
fast, not as one keystroke's round-trip, and only compare runs with the same
`--typing-gap-ms`. Scrolling stays paced — one notch, wait for the screen to
move, next — because wheel notches are coalesced and a burst could not attribute
a movement to a notch.

`scroll-tui` is only itself while xterm is in mouse-tracking mode; otherwise the
wheel never leaves the webview and it is `scroll-buffer` wearing the wrong name.
The runner checks `modes.mouseTrackingMode` before the first notch (and requires
the opposite for `scroll-buffer`), and fails the scenario if tracking drops out
or xterm moves its own viewport mid-run. A refusal here is a setup problem —
usually the payload not being the program on the PTY — not a slow terminal.

A high `drop` count is not slowness — it is inputs that never reached the screen
within `--timeout-ms` at all. Four causes make the terminal stop painting while
still consuming input, and all-drops means one of them:

1. **The window is not in front.** xterm paints on `requestAnimationFrame`, and
   an occluded window gets no frames. The benchmark raises the window and warns
   when the page still reports no focus — that warning means click the window.
2. **A modal is open** (usually the automation trust prompt). Escape is sent
   before each scenario; a dialog that survives aborts the run by design.
3. **The window is showing another project**, so the payload's tab never mounts.
   Opening a tab does not switch the displayed project — selection is written
   through `set_active_selection` and the window reloaded.
4. **The app restarted mid-run** (Tauri's watcher covers `packages/constants`,
   which `bun run dev` regenerates). The driver re-resolves the pid and retries
   the scenario once.

## Rules when changing it

- **Only send keys a synthetic `keydown` can actually deliver.** xterm takes the
  printable path for `keyCode >= 48` only, so a space (32) is dispatched and
  never arrives — it used to be 20% of the corpus, counted as drops and skewing
  every later sample. `#sendKey` throws on such a character; keep `TYPING_TEXT`
  letters and digits.
- **Never make it headless.** A headless run cannot measure a renderer, and the
  renderer is most of the number. There is a separate, deliberate reason the old
  socket-level benchmark was removed.
- **Never add a second literal for a shared name.** `hookGlobal`,
  `runnerGlobal`, `markerPrefix`, and `tabTitle` live in `@pragma/constants`
  under `bench`; the app reads them and so does the injected runner.
- **A load tab must never look like an input.** Its self-driven repaints bump
  `ticks`, never `seq`/`keys`/`wheel` — those are the counters the runner times a
  sample against.
- **Keep the measurement loop inside the webview.** `runner.js` sends and
  measures from the same clock. Anything driven one input per CLI call measures
  the CLI, not the terminal.
- **Keep every `tauri-agent-tools` call pinned to `--pid`.** Auto-discovery can
  pick another developer window and type into it.
- **Watch the five-second eval ceiling.** The bridge kills any single `eval` at
  five seconds, which is why scenarios start asynchronously and are polled.
- **The app-side hook stays dev-only and read-only.** It resolves tab ids on each
  call and holds no references, so terminal disposal and WebGL eviction are
  unaffected. Guard both the call and the body with `import.meta.env.DEV`.
