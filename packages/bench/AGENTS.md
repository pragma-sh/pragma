# packages/bench — Terminal Latency Benchmark

`@pragma/bench` measures how the terminal actually feels: keystroke latency, output
throughput, scroll round-trips, and what happens past eight tabs. It is a **dual
TypeScript + Rust package**, the same shape as `packages/constants`: one `package.json`,
one `Cargo.toml`, and `src/` holding both languages.

It lives in `packages/` rather than `crates/` because it is not a shipped product (a bench
crate under `crates/` would be compiled by every `cargo build --workspace` and every CI
job) and not an app. Its artifact is one benchmark suite whose halves have to be in
different languages to measure honestly.

## Why there are three tiers

Perceived latency is spread across nine hops, from a DOM keydown to a GPU paint. No single
number describes it, so each tier owns the hops it can measure **honestly**:

| Tier   | Where                           | Hops | Measures                                             |
| ------ | ------------------------------- | ---- | ---------------------------------------------------- |
| **T1** | `src/main.rs` (`pragma-bench`)  | 4-7  | Client → local socket → `pragma-server` → PTY → back |
| **T2** | `src/parser.ts`                 | 8    | xterm's parser, via `@xterm/headless`                |
| **T3** | `apps/pragma/src/**/*.bench.ts` | —    | Renderer cache, wheel gate, tab retention            |

Hops 1-3 (DOM → Tauri IPC) and hop 9 (GPU paint) are **deliberately not benchmarked**. A
headless webview cannot paint xterm, so any number produced for them would describe the
harness rather than the app.

T1 drives a real `pragma-server` binary over a real Unix socket through the real
`PragmaClient` — including its queued writer thread, which is itself part of keystroke
latency. Nothing reimplements a hop.

T3 lives in `apps/pragma` and not here on purpose. The policy it measures needs jsdom and a
mocked `@xterm/addon-webgl` before it does anything at all, and both are already configured
there. See _The WebGL trap_ below.

## Commands

```bash
bun run bench                          # all tiers, compare against the local baseline
bun run bench -- --scale quick --reps 2  # fast local loop
bun run bench -- --tier t1             # one tier
bun run bench -- --record              # write/replace the local baseline
bun run bench:audit                    # CI: compare against the committed CI baseline, fail on a gated regression
bun run bench:record                   # write/replace the committed CI baseline

cargo run -p pragma-bench -- --help    # T1 standalone, no bun involved
```

## Running it in a loop

The benchmark never builds the desktop app. `cargo build -p pragma-bench -p pragma-server`
is the whole build: the Tauri crate is not in that dependency graph, so there is no
webview, no frontend bundle, and no sidecar staging. Nor does it touch a running Pragma —
T1 starts its own server in a throwaway `/tmp` directory on its own socket.

Measured cycle times on an M-series laptop:

| Change                           | Command                                                    | Cycle |
| -------------------------------- | ---------------------------------------------------------- | ----- |
| `terminal-manager.ts` (frontend) | `bun run bench -- --tier t3 --scale quick --reps 1`        | ~3 s  |
| `pragma-server` / protocol       | `bun run bench -- --tier t1 --scale quick --reps 1 --fast` | ~35 s |
| The same without `--fast`        | —                                                          | ~75 s |

`--tier t3` skips Cargo entirely. `--fast` swaps the `release` profile for `bench-fast`
(no LTO, 16 codegen units, `opt-level = 2`), which takes an incremental `pragma-server`
rebuild from ~48 s to ~10 s. The release profile's full LTO is right for a bundle built
once and wrong for a loop that rebuilds after every edit.

`--fast` numbers are **not** comparable to release numbers, so it refuses to `--record`.
It can still `--audit`, because structural counters — the only gated class — do not depend
on optimisation level.

A run scoped with `--tier` only audits that tier's metrics. Baseline entries record which
tier produced them, so a `--tier t3` loop is not accused of deleting every transport metric
in the baseline.

**Loop shape that works:** iterate on `--tier tN --scale quick --reps 1 --fast` until the
structural counters are where you want them, then confirm with a full
`bun run bench -- --scale full` before recording anything.

## Answering "did my change do anything?"

The audit is built for regression detection against a recorded baseline, but the same
machinery does A/B. Record a scratch baseline, make the change, compare against it:

```bash
BEFORE=/tmp/before.json

bun run bench -- --tier t1 --scale quick --reps 3 --fast \
  --record --baseline "$BEFORE"

# make the change

bun run bench -- --tier t1 --scale quick --reps 3 --fast \
  --baseline "$BEFORE" --json /tmp/after.json
```

`--baseline` keeps the environment's real baseline untouched, so "before" survives and the
comparison can be repeated. Both sides use the same profile, which is why `--fast` is
allowed to record here but refuses to overwrite the durable baseline. A baseline records
which profile produced it, and comparing across profiles prints a warning — otherwise tens
of percent of optimiser difference would read as a result.

`/tmp/after.json` carries `audit.findings`, one entry per metric, so a caller reads the
answer instead of scraping the table:

```json
{
  "id": "typing.burst.drain",
  "verdict": "improved",
  "current": 4.75,
  "baseline": 8.7,
  "drift": -0.4532,
  "margin": 0.35,
  "gated": false,
  "description": "Time to echo a pasted thousand-word block. …"
}
```

`drift` is signed so **positive is always worse**, whatever the metric's polarity —
throughput included. `verdict` is `improved` past the negative margin, `regressed` past the
positive one, `ok` between.

**Read the counters first.** Structural and coalescing metrics are exact or nearly so, so
they answer "did anything change?" definitively; timings on a shared machine need
repetitions and still carry noise. A worked example — halving `OUTPUT_COALESCE_INTERVAL`
from 8 ms to 4 ms, three repetitions:

| Metric                         | Before | After | Drift  |
| ------------------------------ | ------ | ----- | ------ |
| `typing.burst.drain`           | 8.70   | 4.75  | −45.3% |
| `typing.burst.frames_per_kb`   | 0.149  | 0.447 | +200%  |
| `firehose.ascii.frames_per_mb` | 12.0   | 37.0  | +208%  |
| `firehose.ascii.throughput`    | 22.1   | 13.2  | +40.4% |
| `typing.paced.echo.p50`        | 0.221  | 0.209 | −5.3%  |

The counters land on exact multiples and tell the whole story: a paste drains twice as
fast, at the cost of three times the frames and 40% of bulk throughput. The p50 moved 5%,
which is noise. Do not read a single-digit percentage on a timing metric as a result.

## Files

```
packages/bench/
├── Cargo.toml            # pragma-bench: a lib plus two bins
├── package.json          # @pragma/bench
├── thresholds.json       # allowed drift per metric class, and which classes gate
├── baselines/
│   ├── ci-<os>-<arch>.json   # committed; what CI audits against
│   └── local/                # gitignored; one developer's machine
├── reports/              # gitignored; raw per-repetition samples from every run
└── src/
    ├── index.ts          # `bun run bench` — orchestrates tiers, audits, prints the table
    ├── report.ts         # report shape + the audit. Mirrors report.rs
    ├── report.test.ts
    ├── parser.ts         # T2
    ├── calibrate.ts      # machine-speed probe for the TS tiers
    ├── lib.rs            # T1 library root
    ├── main.rs           # `pragma-bench` bin
    ├── load.rs           # `pragma-bench-load` bin — the payload under measurement
    ├── corpus.rs         # deterministic corpora, shared by T1 and T2
    ├── harness.rs        # server + session lifecycle
    ├── stats.rs
    └── scenarios/        # typing, firehose, scroll, tabs
```

## How a measurement is made trustworthy

Four things, each load-bearing:

1. **A deterministic payload.** Sessions `exec` `pragma-bench-load` in place of the shell,
   after `stty raw -echo`. Benchmarking a real login shell would fold its prompt, plugins,
   and start-up into every sample, and those differ per machine and per developer.
2. **Shared corpora.** `corpus.rs` generates them from a seeded PRNG; T2 gets the identical
   bytes by running `pragma-bench-load corpus`. Changing `SEED` invalidates every baseline.
3. **Repetitions reduce by class.** Wall time and throughput take the **best** observation,
   because measurement noise is one-sided — a bad scheduling decision can only make
   something slower, never faster. Counters take the **worst**, because they are supposed
   to be identical and a repetition that disagreed found something real. The rule is stated
   once per language (`MetricClass::reduces_to_worst`, `reducesToWorst`) and both are
   tested with the same cases.
4. **Calibration.** Every report carries `calibrationNs` from a fixed CPU-bound probe.
   Wall-time and throughput metrics are compared as `value / calibrationNs`, so a faster or
   slower runner moves the probe and the measurement together and a recorded baseline
   survives a runner upgrade. Counters and ratios are **not** calibrated — dividing a frame
   count by a CPU probe would make it meaningless.

## Metric classes and what gates

`structural` counters are the only gated class today, and that is backed by measurement
rather than caution: across repeated local runs they were bit-identical every time, while
every timing-derived class swung by tens of percent between runs on the same machine at the
same commit. A margin guessed from a handful of recordings produces a check that goes red
for no reason, gets ignored, and then misses the regression it existed for.

Everything else is **report-only**: its drift is printed (marked `*`) and never fails the
build. Watch those columns in CI, and promote a class to `gate: true` in `thresholds.json`
once its real spread is known. That promotion is a deliberate, reviewed change.

Two rules that are not negotiable:

- **A metric in the baseline that the run did not produce always fails**, whatever its
  class allows. That is how a renamed or deleted measurement is caught instead of quietly
  shrinking coverage.
- **Every metric in the `coalescing` class counts frames per unit of work**, so a _rise_ is
  always the regression. Never invert one into "bytes per frame": the worst-case reduction
  keeps the highest value, so an inverted metric would silently keep the best observation.

## Baselines

Keyed `{ci|local}-{os}-{arch}`. CI baselines are committed so a change to them shows up in
review; local ones are gitignored, because every developer's machine differs and committing
them would only produce merge conflicts.

**Never record a baseline from a machine in a known-bad state** — a loaded laptop, a branch
with an open performance problem, a thermally throttled runner. The recording becomes the
definition of "correct", and a real regression measured against it looks like an
improvement.

Re-record CI baselines through the `Bench` workflow's `workflow_dispatch` with
`record: true`. It uploads the new file as an artifact instead of committing it, so the
bump arrives as a reviewed commit.

## The WebGL trap

`terminal-manager.ts` constructs `WebglAddon` inside a `try`. Headless has no GPU, so it
hits the `catch`, keeps the DOM renderer, and **never populates the LRU it is supposed to
populate**. A benchmark that does not mock `@xterm/addon-webgl` therefore reports an empty
renderer cache and asserts nothing at all. `terminal-frontend.bench.ts` mocks it; the
accounting is real even though the GPU is not.

The same shape of trap caught the wheel gate: calling `onData` with a wheel report does
**not** exercise the gate. `terminal-manager` only routes a report through it when a real
wheel event was handled immediately before, so `onData` alone measures the ungated fallback
and reports one PTY write per report — a number that looks like a broken gate but is really
a broken harness. Drive `attachCustomWheelEventHandler`'s handler first.

## Gotchas

- **Socket paths are capped at 107 bytes.** macOS's per-user `TMPDIR` (`/var/folders/…`) is
  long enough to overrun it once a channel and a socket name are appended, so
  `short_scratch_dir` roots the server under `/tmp` on Unix.
- **`XDG_RUNTIME_DIR` wins on Linux.** The server prefers it over `PRAGMA_APP_DATA_DIR`, so
  the harness redirects both — otherwise the benchmark attaches to the developer's real
  server.
- **Search the output buffer before trimming it.** A payload that announces itself and then
  floods gets its marker and a great deal of corpus coalesced into one frame; trimming
  first discards the marker and the wait never ends. `OutputBuffer` has a regression test.
- **Background sessions must be drained.** The server drops output to a subscriber whose
  channel is full, which would both relieve the load the scenario is applying and hide the
  loss. `EventFrame::Replay { reset: true }` is the observable evidence of a drop and is
  reported as `tabs.n*.replay_resets`.
- **Expect keystroke latency to be bimodal.** The server flushes at most once per 8 ms
  coalescing interval, and the paced 10 ms cadence beats against it, so samples sweep the
  whole range. That is what a person typing experiences — gate percentiles, not means.

## Adding a scenario

1. Add a module under `src/scenarios/` (T1) or a case in `src/parser.ts` (T2).
2. Give every metric a **stable dotted id** and a one-line `description` saying what
   regressing it would mean for a user — the description is printed when the audit fails,
   and it is what makes a red build actionable.
3. Pick the class honestly. If the value depends on timing in any way, it is not
   `structural`, however much it looks like a count.
4. Run `bun run bench -- --record` locally, then re-record the CI baseline through the
   workflow. A new metric reports as `new` and never fails, so it can land first.
