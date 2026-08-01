# @pragma/bench — terminal lag benchmark

Measures what a user actually feels in a Pragma terminal: how long a keystroke
takes to appear, and how long a scroll takes to move. It does this by launching a
**real Pragma dev instance**, running a real TUI in a real terminal tab, and
driving that window with real DOM input events. Nothing here is headless — a
headless run cannot measure a renderer, and the renderer is most of the answer.

It also measures under **load**: ten terminal tabs by default, nine of them
running the TUI payload on a timer for the whole run, one of them driven.

```bash
bun run benchmark                       # all three scenarios, default counts
bun run benchmark -- --keystrokes 500   # flags pass through to `pragma-bench run`
bun run benchmark -- --only typing
bun run benchmark -- --typing-gap-ms 8  # slow the typing burst down (0 = flat out)
bun run benchmark -- --tabs 1           # measure an idle window instead
bun run benchmark -- --tabs 20 --load-interval-ms 25   # heavier workspace
bun run benchmark -- --keep-open        # leave the dev window up afterwards
```

## Layout

Dual TS + Rust in one package, like `packages/constants`:

| Path               | What it is                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| `src/index.ts`     | `bun run benchmark` launcher. Builds the binary, execs it. Nothing else. |
| `src/main.rs`      | `pragma-bench` CLI: `run`, `tui`, `lines`                                |
| `src/tui.rs`       | The ratatui payload: 5000 lines, mouse capture, status row, `--auto-ms` |
| `src/lines.rs`     | The scrollback payload: same corpus, dumped and parked                   |
| `src/corpus.rs`    | The content both payloads render                                         |
| `src/instance.rs`  | Dev-instance lifecycle: spawn, discover, register project, open tabs     |
| `src/driver.rs`    | Everything that talks to `tauri-agent-tools`                             |
| `src/runner.js`    | The scenario loop, injected into the webview                             |
| `src/scenarios.rs` | Scenario definitions and the install/start/poll cycle                    |
| `src/stats.rs`     | Percentiles                                                              |
| `src/report.rs`    | Console table + `bench-report.json`                                      |

## Prerequisites

- **`tauri-agent-tools`** on `PATH` (`npm install -g tauri-agent-tools`). The run
  fails immediately with that message if it is missing.
- **macOS or Linux.** `dev_bridge.rs` writes its token to a hard-coded `/tmp`
  path, so the benchmark refuses to start on Windows rather than scanning a
  directory that will always be empty there.
- **No other dev server running.** `tauri.conf.json` pins `devUrl` to one port,
  so a second `bun run dev` dies with `Port 1420 is already in use` — and Tauri
  reports only `The "beforeDevCommand" terminated with a non-zero status code`,
  five minutes into a build. The benchmark pre-flights the port and refuses to
  start with that as the reason instead. Quit the other dev instance first.
- Nothing else. If the dev instance has never seen this worktree, the benchmark
  registers it by invoking `add_project`, then waits for the workspace snapshot.

## One tab is measured; the rest are load

A window with a single terminal in it is not the window anybody works in. A real
worktree has several agents streaming at once, and their PTY traffic, IPC events,
and xterm parsing are paid on the same threads as the tab being typed into — so a
number from an idle window systematically understates what a user feels.

`--tabs` (default 10) is the total number of terminal tabs open while a scenario
runs, **counting the measured one**. The other `--tabs - 1` run
`pragma-bench tui --auto-ms <--load-interval-ms>` (default 50ms, about 20 frames a
second each): the same payload, but repainting on a timer instead of waiting for
input, so it scrolls itself for the whole benchmark with nobody driving it.

- **They are opened first and closed last.** Every scenario is measured under the
  same load, or the scenarios are not comparable with each other.
- **Each one is waited for before the next is opened**, and all of them before
  the payload tab exists. A PTY spawning and a shell starting are one-off costs;
  a scenario that began while nine of them were still landing would measure the
  start-up.
- **Only ever one tab is driven.** The measured payload tab is opened *last*,
  because `tabOpened` makes the new tab the active one — whichever tab was opened
  last is the one in front, and only the tab in front is painted.
- **A background tab stays mounted, hidden, and fed.** `SplitHost` retains a
  terminal once it has been active, `flushOutput` writes to it regardless of
  visibility, and only painting is skipped — which is exactly the cost a real
  background agent imposes.
- **`--tabs 1` reproduces the old behaviour** (idle window, one tab). The tab
  count is printed above the table and stored in `bench-report.json`, because two
  runs are only comparable at the same load.

A load tab's status row carries a `ticks=` counter that no other counter mirrors:
`seq`, `keys`, and `wheel` are the runner's, and a self-driven repaint must never
look like an input something is waiting for.

## The three scenarios

| Name            | Path measured                                   | Payload              |
| --------------- | ----------------------------------------------- | -------------------- |
| `typing`        | keydown → PTY → TUI redraw → xterm paint        | `pragma-bench tui`   |
| `scroll-tui`    | wheel → mouse report → TUI redraw → xterm paint | `pragma-bench tui`   |
| `scroll-buffer` | wheel → xterm scrollback → xterm paint          | `pragma-bench lines` |

`scroll-tui` and `scroll-buffer` are deliberately both present. The first pays a
full PTY round-trip and goes through `TerminalManager`'s wheel pacing (see
`awaitingWheelResponse`); the second never leaves the webview. A regression that
shows up in one but not the other tells you which half moved.

### The two scroll scenarios are only distinct while the TUI owns the wheel

`scroll-tui` measures what it claims to measure **only** while xterm is in
mouse-tracking mode: that is what turns a wheel notch into a mouse report on the
PTY instead of a scroll of xterm's own scrollback. If capture is off, the wheel
never leaves the webview and the scenario is `scroll-buffer` under another name —
a wrong number, not a missing one. So it is verified, not assumed:

- **Before the first notch.** `ready()` reports xterm's own
  `modes.mouseTrackingMode` (the same value `TerminalManager` gates its wheel
  pacing on) and whether the alternate buffer is up. `scroll-tui` refuses to
  start unless tracking is on; `scroll-buffer` refuses unless it is off. A
  terminal that has painted the status row but not yet entered tracking is a
  race worth waiting out, so this is part of the readiness poll.
- **For the whole run.** Every frame re-reads the mode and xterm's `viewportY`.
  Tracking dropping out mid-run (`mouseLost`) or xterm moving its own viewport
  (`xtermScrolled`) fails the scenario with that as the reason.
- **In the payload.** A sample is the payload's `off` counter changing, so an
  offset that stopped moving because the corpus ran out would look exactly like a
  dropped frame. `on_mouse` therefore wraps at both ends instead of clamping —
  every notch is a visible movement no matter how many `--scroll-ticks` are sent.

**A wheel notch must have somewhere to go.** `scroll-buffer` scrolls _up_ and
turns round at either end, because the `lines` payload parks at the bottom of its
5000 lines: notches sent downward from there moved nothing and the scenario
reported 100% dropped — indistinguishable, in the table, from a terminal too slow
to paint. That is also why the report now calls out any scenario that measured
nothing at all as a setup failure rather than printing a row of zeroes.

## How a sample is measured

Two facts make this work:

1. **The TUI reports its own progress.** `pragma-bench tui` paints a status row
   on row 0 — `PRAGMABENCH seq=… off=… keys=… wheel=… frame=…` — and redraws
   exactly once per input event it processes. The benchmark never has to guess
   whether an input arrived.
2. **The loop runs inside the webview.** `runner.js` sends the input and reads
   the paint from the same `performance.now()` clock. A bridge round-trip costs
   tens of milliseconds, so a CLI-driven loop would measure the CLI.

One sample is `first onRender whose status proves this input landed` minus `the
moment the event was dispatched`. Scroll scenarios key off the offset moving
rather than a counter, because a wheel report the app deliberately paced away
never moved the screen and should not be recorded as a fast frame.

An input that does not reach the screen within `--timeout-ms` is counted in
`dropped` rather than being recorded as a very slow sample.

### Typing bursts; scrolling is paced

The two loops in `runner.js` are deliberately different, because the two input
kinds are:

- **Typing sends everything at once, as fast as the page can dispatch**
  (`--typing-gap-ms`, `0` by default). Keystrokes do not wait for each other, so
  many are in flight at a time — which is what fast typing and pasting actually
  are, and it is the case where lag is felt. A loop that only ever typed into an
  already-caught-up terminal could not observe a queue forming at all, so it
  under-reported exactly the complaint the benchmark exists to catch. The
  payload's `keys` counter only grows, so a frame reporting `keys=n` settles
  every keystroke up to `n` at once, each against its **own** send time.
- **Scrolling still sends one notch at a time**, waiting for the screen to move
  before the next (`--gap-ms`, 16 by default). Wheel notches are deliberately
  coalesced — by xterm's pixel accumulator and by `TerminalManager`'s wheel
  pacing — so a burst would produce fewer movements than notches with no way to
  attribute a movement to a notch. Sending on movement keeps one notch = one
  sample.

Pacing a burst with `setTimeout(…, 0)` would not work: a timer scheduled inside a
timer callback is nested, and the HTML spec clamps nested timers to 4ms — a
silent ceiling of ~250 characters a second. `pause(0)` uses a `MessageChannel`
task instead, which has no clamp and still leaves room between tasks for a frame.

### Why the app needs a hook

The terminal renders through `WebglAddon`. There are no `.xterm-rows` in the DOM
and the canvas pixels are not retrievable, so the benchmark needs the xterm
instance itself. `TerminalManager.installBenchHook()` exposes one on `window` —
**dev builds only**, guarded twice by `import.meta.env.DEV` so it is dropped from
production bundles. It resolves tab ids against the live map on every call and
holds no references, so terminal disposal and WebGL eviction are unaffected.

The three names the app and this package share (`hookGlobal`, `runnerGlobal`,
`markerPrefix`, plus `tabTitle`) live in `@pragma/constants` under `bench`. Never
spell any of them literally in a second place.

## Reading the output

```
10 tab(s) open, 1 measured — the rest running the TUI payload under it

scenario           n    drop      p50      p95      p99      max     mean  path
typing           300       0    12.4m    31.2m    58.0m    74.0m    15.1m  keydown → PTY → TUI redraw → xterm paint
```

`bench-report.json` carries the same numbers plus every raw sample, so two runs
can be compared without re-running either.

`typing` is a burst, so read its numbers as a queue draining, not as one
keystroke's round-trip: p50 is roughly how far behind the terminal runs while
someone types fast, and max is the worst moment of the burst. It is a harsher
number than a paced loop's by design, and it is only comparable against another
run at the same `--typing-gap-ms`.

There is **no pass/fail threshold**, deliberately. These numbers move with the
machine, the display's refresh rate, and whatever else is compiling at the time;
a gate on them would fire on noise. Compare a branch against `main` on the same
machine, minutes apart — and at the same `--tabs`, which moves them as much as
any code change does.

## Four things that silently produce a 100%-dropped run

Every one of these was found the hard way; each makes the terminal stop
_painting_ while still consuming input, so the buffer advances, no `onRender`
fires, and every sample times out. The benchmark now handles all four, but if
you see a scenario reporting all drops, this is the list to check.

1. **The window must be in front.** xterm paints from `requestAnimationFrame`,
   and an occluded window gets no frames. `focus()` raises it before every
   scenario (`osascript` on macOS, `xdotool` on X11 — a Wayland session has no
   equivalent) and the runner records `unfocused` if focus was ever lost, which
   the report prints as "not a measurement". Raising can fail silently on macOS
   without Accessibility permission, so the warning is your cue to click the
   window.
2. **A modal blocks painting.** The automation trust prompt ("… wants to run
   background code on this host") is the one that shows up in practice, on any
   worktree with untrusted automations. `clear_modals` sends Escape before each
   scenario and refuses to run if a dialog survives. It never clicks a button —
   answering a trust prompt is not a benchmark's decision.
3. **Opening a tab does not bring its project to the front.** The app's
   `tabOpened` handler selects the worktree _within_ its project but never
   switches the displayed project, so a window sitting on another project mounts
   no `TerminalView` for the new tab. `show_worktree` writes the selection
   through `set_active_selection` and reloads, which is what actually moves the
   window.
4. **The app restarts itself early in a run.** Tauri's dev watcher covers
   `packages/constants`, which `bun run dev` regenerates on its way up. The
   driver re-resolves the app's pid on "No bridge found", and `measure` re-injects
   the runner and reopens the load tabs and then the payload tab once before
   failing. The load tabs are part of that recovery because a fresh document
   mounts only the *active* tab: the surviving load payloads would still be
   running with nothing attached to them, so the run would silently continue
   against an idle window.

## Gotchas

- **The dev instance is scoped to the worktree it was compiled in.** That is what
  makes it findable: the channel, data directory, and socket all derive from the
  repo root, so `pragma-bench run` computes them rather than guessing at windows.
- **`--pid` is not optional.** `tauri-agent-tools` auto-discovery picks a bridge
  from a shared token directory, and a developer usually has more than one dev
  build open. Every call this package makes pins the pid it launched, so a
  benchmark's keystrokes can never land in somebody's real editor.
- **The bridge caps one `eval` at five seconds.** That is why the scenario starts
  asynchronously and is polled, instead of being awaited in a single call.
- **The payloads park instead of exiting.** A payload that returned would give the
  shell its prompt back — and, for a single-command session, close the tab —
  before anything had been scrolled.
- **Load tabs share the payload tab's title**, so `close_stale_payload_tabs`
  reclaims them too when a run is interrupted. Ten orphaned TUIs repainting
  forever would otherwise poison the next run's numbers rather than the current
  one's.
- **A failed `tauri-agent-tools` call is not a failed scenario.** The measurement
  loop lives in the page and keeps going; the CLI's own HTTP timeout fires
  routinely while the window is busy redrawing 5000 lines. Progress polls
  tolerate `MAX_POLL_FAILURES` in a row, and injection is retried.
- **A synthetic `keydown` cannot deliver a space.** xterm takes the printable
  path in `evaluateKeyboardEvent` only for `keyCode >= 48`; space is 32, and a
  real one arrives through the hidden textarea's `keypress`/`input` event, which
  the browser generates only for genuine key input. The corpus was
  `"the quick brown fox …"`, so 9 characters in 44 were dispatched and never
  arrived — a flat 20% of every typing run counted as dropped, _and_ every later
  sample matched against the wrong keystroke's send time, because the payload's
  `keys` counter ran that far behind the index being timed. Removing the spaces
  took a 150-keystroke run from "120 measured, 30 dropped, p50 134ms" to "150
  measured, 0 dropped, p50 30ms". `#sendKey` now throws rather than dispatching a
  character it cannot deliver.
- **Teardown has to walk the whole process tree.**
  `pragma_platform::process::kill_tree` reaches one generation on Unix
  (`pkill -P`), and the dev instance is four deep (`bun run dev` → `bash -c` →
  `tauri dev` → the app, plus Vite). Killing only the supervisor reparents the
  rest to init, where they hold Vite's port and the _next_ run refuses to start
  with "port 1420 is already in use" — pointing at a dev server the user never
  launched. `DevInstance::drop` collects descendants from the process table
  first, then kills leaves before the root.
- **Expect a long rebuild between a bench change and a run.** `cargo build -p
pragma-bench` and the app's own build resolve features differently for the
  crates they share, so each invalidates the other. Two or three minutes of
  "still building/starting" after touching this package is normal, not a hang.
- **Run it on an idle machine.** A concurrent `cargo build` is worth tens of
  milliseconds at p95, which is the whole signal.
