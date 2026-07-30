---
name: performance-benchmark
description: Use when measuring or defending Pragma's terminal performance — keystroke latency, output throughput, TUI scroll, multi-tab scaling, the WebGL renderer cache, or the mouse-wheel gate. Covers running `bun run bench`, picking a tier, the fast rebuild profile, A/B-ing a change to see whether it did anything, reading drift and verdicts, recording baselines, and the CI audit. Use it before claiming a performance change helped, and when a Bench check fails.
---

# Measure Pragma's Terminal Performance

The benchmark lives in `packages/bench` (dual TypeScript + Rust). Read
`packages/bench/AGENTS.md` for the full contract; this skill is the operating procedure.

**Never claim a performance change helped without an A/B run.** Terminal latency is spread
across nine hops and intuition about which one moved is wrong more often than not.

## Pick The Tier First

Run only the tier that can see your change. A full run is for recording, not for iterating.

| You changed                                                         | Tier | Command suffix     | Cycle |
| ------------------------------------------------------------------- | ---- | ------------------ | ----- |
| `pragma-server`, `pragma-client`, `pragma-protocol`, PTY, coalescer | t1   | `--tier t1 --fast` | ~35 s |
| xterm parsing, corpora, chunking                                    | t2   | `--tier t2 --fast` | ~30 s |
| `terminal-manager.ts`: renderer cache, wheel gate, retention        | t3   | `--tier t3`        | ~3 s  |

`--tier t3` runs no Cargo at all. `--fast` builds with the `bench-fast` profile, taking an
incremental `pragma-server` rebuild from ~48 s to ~10 s; the release profile's full LTO is
right for a shipped bundle and wrong for a loop.

Hops 1-3 (DOM → Tauri IPC) and hop 9 (GPU paint) are **not measured and cannot be**. A
headless webview cannot paint xterm. Do not add a tier that pretends otherwise.

## Rebuilding Is Automatic

`bun run bench` runs `cargo build` itself every invocation, so a Rust edit is picked up with
no manual step. Cargo's incremental build decides what to recompile. The TypeScript tiers
are transpiled on the fly by bun and vitest — nothing to build.

The desktop app is **never** built. `pragma-bench` and `pragma-server` are the whole
dependency graph: no webview, no frontend bundle, no sidecar staging. `bun run generate` is
not needed either — the app's constants imports in the measured path are `import type`, so
they erase at runtime.

A benchmark run also never touches a running Pragma instance. T1 starts its own server in a
throwaway `/tmp` directory on its own socket.

## Did My Change Do Anything?

Record a scratch baseline, change the code, compare against it:

```bash
BEFORE=/tmp/before.json

bun run bench -- --tier t1 --scale quick --reps 3 --fast --record --baseline "$BEFORE"
# make the change
bun run bench -- --tier t1 --scale quick --reps 3 --fast --baseline "$BEFORE" --json /tmp/after.json
```

`--baseline` keeps the environment's real baseline untouched, so "before" survives and the
comparison can be repeated. Both sides must use the same profile — a baseline records which
one produced it, and a mismatch prints a warning, because tens of percent of optimiser
difference would otherwise read as a result.

`/tmp/after.json` carries `audit.findings`, one entry per metric, so read the answer instead
of scraping the table:

```json
{
  "id": "typing.burst.drain",
  "verdict": "improved",
  "current": 4.75,
  "baseline": 8.7,
  "drift": -0.4532,
  "margin": 0.35,
  "gated": false
}
```

## Reading The Result

1. **Counters first.** `structural` and `coalescing` metrics are exact or near-exact, so
   they answer "did anything change?" definitively. Timings on a shared machine need
   repetitions and still carry noise.
2. **`drift` is signed so positive is always worse** — throughput included, where the raw
   value moves the other way. Never re-derive direction yourself.
3. **A single-digit percentage on a timing metric is not a result.** If that is all the
   change produced, raise `--reps` or accept it is below the measurement floor.
4. **Exit code 0 means no _gated_ regression.** Only structural counters gate today.
   Timing drift prints, marked `*`, and never fails — so a loaded machine cannot wedge a
   loop. Branch automation on the exit code; read the table for judgement.

A worked example — halving `OUTPUT_COALESCE_INTERVAL` from 8 ms to 4 ms:
`typing.burst.drain` −45%, `typing.burst.frames_per_kb` +200%, `firehose.ascii.throughput`
+40% worse, `typing.paced.echo.p50` −5% (noise). The counters land on exact multiples and
tell the whole story; the p50 says nothing.

## Recording Baselines

- **Never record from a machine in a known-bad state** — a loaded laptop, a branch with an
  open performance problem, a throttled runner. The recording becomes the definition of
  "correct", and a real regression measured against it looks like an improvement.
- Confirm with a full `bun run bench -- --scale full` before recording anything.
- `--fast` will not overwrite the environment baseline; it may record only to an explicit
  `--baseline` scratch path.
- Re-record the committed CI baseline through the `Bench` workflow's `workflow_dispatch`
  with `record: true`. It uploads the file as an artifact rather than committing, so the
  bump lands as a reviewed commit.
- A run scoped with `--tier` only audits that tier's metrics, so a `t3` loop is not accused
  of deleting every transport metric.

## When The Bench CI Check Fails

It only fails on a structural counter or a metric that vanished. Both are real.

1. Download the `bench-report` artifact — it has per-repetition sample vectors, and
   re-running produces different numbers.
2. Read the failing metric's `description`; it states what regressing it means for a user.
3. A `missing` verdict means a metric was renamed or deleted. Restore the id, or record a
   new baseline deliberately.
4. Reproduce locally with the same `--tier` and `--scale full`.

## Adding A Scenario

1. T1 → a module under `packages/bench/src/scenarios/`. T2 → a case in `src/parser.ts`.
   T3 → `apps/pragma/src/**/*.bench.ts`.
2. Give every metric a **stable dotted id** and a one-line `description` saying what
   regressing it would mean for a user. That text is printed when the audit fails and is
   what makes a red build actionable.
3. **Pick the class honestly.** If the value depends on timing in any way it is not
   `structural`, however much it looks like a count. Frame density depends on the server's
   8 ms coalescing window racing however fast bytes arrive — that is `coalescing`.
4. Every `coalescing` metric must count **frames per unit of work**, so a rise is the
   regression. Never invert one into "bytes per frame": repetitions reduce counters to the
   worst observation, so an inverted metric would silently keep the best one.
5. A new metric reports as `new` and never fails, so it can land before its baseline.

## Traps That Produce Fake Numbers

Each of these was hit while building the harness. All produce a plausible-looking number
that measures nothing.

- **A headless benchmark that does not mock `@xterm/addon-webgl` measures an empty renderer
  cache.** `terminal-manager.ts` constructs the addon in a `try`; with no GPU it hits the
  `catch`, keeps the DOM renderer, and never populates the LRU.
- **Calling `onData` with a wheel report does not exercise the wheel gate.**
  `terminal-manager` only routes a report through the gate when a real wheel event was
  handled immediately before, so `onData` alone measures the ungated fallback and reports
  one PTY write per report — which looks like a broken gate and is a broken harness. Drive
  `attachCustomWheelEventHandler`'s handler first.
- **Search an output buffer before trimming it.** A payload that announces itself and then
  floods gets its marker and a lot of corpus coalesced into one frame; trimming first
  discards the marker and the wait never ends.
- **Background sessions must be drained.** The server drops output to a subscriber whose
  channel is full, which relieves the load the scenario is applying _and_ hides the loss.
- **Benchmark a deterministic payload, not a login shell.** Prompts and plugins differ per
  machine and per developer.
- **Expect keystroke latency to be bimodal.** The 10 ms paced cadence beats against the
  server's 8 ms coalescing interval. Gate percentiles, never means.
