---
name: jev
description: Use when verifying a Pragma change in the real running dev app — clicking through the UI, typing into a terminal, checking what renders, taking and analysing a screenshot — or whenever you would otherwise reach for tauri-agent-tools or a "run this command in a dev tab" pass-through. `bun run jev` drives the live `bun run dev` window like a person would, with a Jev-powered agent that takes a goal and works through it.
---

# jev — drive the running Pragma dev app

`jev` (`packages/jev`, run as `bun run jev -- …` from the repo root) controls a **running,
visible** Pragma dev build through the dev bridge (`apps/pragma/src-tauri/src/dev_bridge.rs`).
It has full DOM access. It sends real pointer, mouse, keyboard, wheel, and input events at real
coordinates, so React, Radix, and xterm handle them exactly as they would a person's. It never
runs headless and never starts an app for you.

## Before you start

1. A dev instance must be running: `bun run dev`, with its window open. Check with
   `bun run jev -- instances`. jev picks the instance built from the current checkout (its
   binary lives under this worktree's `target/`). Pass `--pid <n>` when several are running.
2. A Rust change restarts the dev app (Tauri's watcher). Wait for the new pid before driving it.
3. jev's agent needs an OpenRouter key: `JEV_API_KEY` / `OPENROUTER_API_KEY`, or
   `JEV_API_KEY=…` in `~/.pragma/jev.env`. A typesafe-computer-use install's
   `~/.typesafe-computer-use/.env` is also read. The direct commands below need no key.

## Default workflow: give jev a goal

```bash
bun run jev -- run "Open a new terminal tab, run 'git status', and report whether the tree is clean"
```

jev loops through snapshot → decide → act → observe until it reports `done` (exit 0) or
`fail` (exit 1), asks a question (exit 2), or runs out of steps (exit 3, default 25,
`--steps N`). Every step prints a line to stderr. The final report, the final screenshot
path, and the run folder go to stdout.

- **Write goals as checks.** "…and report X" makes jev verify and quote evidence, rather
  than just click.
- **Give it the text it needs.** `--input name=feature-x --input branch=main`. jev types
  these values when the goal needs them and never invents content.
- **When it asks a question** (exit 2), it prints the question and a resume command. Answer
  with `bun run jev -- run --resume <run-id> --answer "<text>"`. If you don't know the
  answer, relay the question to the user.
- **Out of steps** (exit 3): `bun run jev -- run --resume <run-id> --steps 15`.
- **Vision:** `--vision auto` (default) attaches a screenshot only when jev asks for one.
  `--vision always` sends one every step, for visual or layout goals. `never` disables them.
- **Always check the evidence yourself.** Read the report, then `Read` the final screenshot
  (`final.png` in the run folder). The run folder also holds `step-NN.txt` (exactly what jev
  saw and decided) and `session.json`.

## The terminal is a canvas

Terminal panes are xterm.js drawn on a WebGL `<canvas>`, so the DOM holds no text for them.
jev reads their text from the dev-only `window.__PRAGMA_BENCH__` hook and lists each visible
terminal as `[index] TERMINAL (canvas)` followed by its rows. Clicking that index focuses the
terminal, the same as clicking into it. After that, `type` and `key` go to the shell.

```bash
bun run jev -- terminal run "bun --version" --wait 2000   # click in, type, Enter, print the screen
bun run jev -- terminal read [--full]                      # visible rows (or scrollback, all tabs)
```

`terminal run` replaces the old `bun run dev:command` pass-through. It types into the
visible terminal like a user would, rather than opening a tab behind the UI's back.

## Direct control, step by step

Indexes come from the latest `snapshot` and are invalid after the next one.

```bash
bun run jev -- snapshot              # elements with [index], state flags, terminals, visible text
bun run jev -- click 12              # or a CSS selector: click "[data-tour=add-project]"; --right/--double; --at x,y
bun run jev -- type "hello" --into 7 --enter
bun run jev -- key "Meta+t"          # chords and sequences: "Escape", "Control+c", "Shift+Tab Enter"
bun run jev -- scroll down --amount 5 --on 30
bun run jev -- select 9 "Dark"       # native <select> only
bun run jev -- eval "document.title" # raw JS in the webview (5 s cap, promises awaited)
bun run jev -- logs                  # drain buffered Rust log lines
```

Native-menu chords (⌘T new terminal tab, ⌘W close tab, ⌘P / ⌘⇧P palette, ⌘, Settings) are
sent to the native menu item through the bridge's `/menu` endpoint. macOS delivers those
chords to the menu bar, never to the webview, so this is the path a real keystroke takes.
System shortcuts (⌘Q, ⌘Tab) are out of reach.

## Screenshots

```bash
bun run jev -- screenshot -o /path/to/shot.png   # prints the path; then Read it
bun run jev -- look "Is the tab bar clipped at this width?"   # screenshot + screen text, answered by Jev
```

The dev app captures its own window (bridge `/screenshot`, through `xcap`), so this works
under Pragma Dev's Screen Recording grant, whatever terminal you run from. If that fails,
jev falls back to `screencapture` / `import`, which need the terminal's grant. jev raises
the window first: WebKit stops painting an occluded window, so a capture of a buried window
shows a stale frame.

## Rules

- These are real actions in a real app. Don't delete projects or worktrees, push, or close
  tabs you didn't open unless the task needs it. Tidy up the tabs you open.
- Prefer a goal-driven `run` for anything with more than two or three steps. Use the direct
  commands for precise, scripted checks.
- If jev's report and the screenshot disagree, trust the screenshot and say so.
