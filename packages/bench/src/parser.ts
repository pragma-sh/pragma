/**
 * T2 — xterm's parser (hop 8), via `@xterm/headless`.
 *
 * The transport tier stops at the point output reaches the client. This tier
 * picks it up there and measures what it costs to turn those bytes into terminal
 * state: escape-sequence dispatch, wide-character handling, and scrollback.
 * It runs headless, so nothing here measures painting — that is hop 9, which a
 * headless environment cannot honestly measure at all.
 *
 * The corpora come from `pragma-bench-load corpus`, the very same generator the
 * transport tier streams through a real pseudoterminal, so the two tiers'
 * numbers describe byte-identical input.
 */

import { Terminal } from "@xterm/headless";

import { pushLatency, type Measured, type Metric } from "./report.ts";

/** Corpus kinds, matching `CorpusKind` in `src/corpus.rs`. */
const CORPUS_KINDS = ["ascii", "sgr", "cjk", "redraw"] as const;

export type CorpusKind = (typeof CORPUS_KINDS)[number];

/**
 * Bytes submitted to the parser in one `write`.
 *
 * Mirrors `TERMINAL_WRITE_CHUNK_MAX_BYTES` in
 * `apps/pragma/src/lib/terminal-manager.ts`. It is deliberately *not* imported
 * from there — this package does not depend on the app — so the frontend tier
 * reports the app's real value as a structural metric instead. If the two ever
 * diverge, that metric moves and the audit says so.
 */
const WRITE_CHUNK_BYTES = 64 * 1024;

/** Viewport used for parsing runs. Wide enough that reflow is not the subject. */
const COLS = 200;
const ROWS = 50;

/** Scrollback retained, matching the app's `TERMINAL_SCROLLBACK_LINES`. */
const SCROLLBACK = 5000;

/** Lines scrolled per wheel notch in the local-scroll case. */
const SCROLL_STEP = 3;

/** Wheel notches per direction before reversing. */
const SCROLL_RUN = 20;

/** Terminals retained in the memory case, mirroring a session with many tabs. */
const RETAINED_TERMINALS = 16;

/** Runs the whole parser tier once. */
export async function runParserTier(options: {
  corpusFor: (kind: CorpusKind) => Promise<Uint8Array>;
  scrollNotches: number;
}): Promise<Measured> {
  const measured: Measured = { metrics: [], samples: {} };
  for (const kind of CORPUS_KINDS) {
    const corpus = await options.corpusFor(kind);
    measured.metrics.push(...(await parseCorpus(kind, corpus, measured)));
  }
  await localScroll(measured, options.scrollNotches);
  measured.metrics.push(await retainedTerminalCost());
  return measured;
}

/** Feeds one corpus through the parser in app-sized chunks. */
async function parseCorpus(
  kind: CorpusKind,
  corpus: Uint8Array,
  measured: Measured,
): Promise<Metric[]> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
  const chunkLatencies: number[] = [];
  const started = performance.now();
  for (let offset = 0; offset < corpus.length; offset += WRITE_CHUNK_BYTES) {
    const chunk = corpus.subarray(offset, offset + WRITE_CHUNK_BYTES);
    const chunkStarted = performance.now();
    // Await the parse callback rather than just the call: `write` queues, so
    // timing the call alone would measure enqueueing and report a parser that
    // is infinitely fast.
    await new Promise<void>((resolve) => {
      terminal.write(chunk, resolve);
    });
    chunkLatencies.push(performance.now() - chunkStarted);
  }
  const elapsedSeconds = Math.max((performance.now() - started) / 1000, Number.EPSILON);
  terminal.dispose();

  pushLatency(
    measured,
    `parser.${kind}.chunk`,
    chunkLatencies,
    `Time for xterm to parse one ${WRITE_CHUNK_BYTES / 1024} KiB chunk of ${kind} output. ` +
      "This is the cost that sits between output arriving and the screen being able to change.",
  );
  return [
    {
      id: `parser.${kind}.throughput`,
      value: corpus.length / elapsedSeconds / (1024 * 1024),
      unit: "MB/s",
      class: "throughput",
      description:
        `Rate at which xterm parses ${kind} output. Regressing this is felt as a build ` +
        "log that paints slowly even though the bytes arrived quickly.",
    },
  ];
}

/**
 * Scrolls the viewport up and down through a full scrollback, reversing
 * periodically.
 *
 * This is the local-scroll case: no application is involved, so nothing crosses
 * the pseudoterminal and the whole cost is xterm's own viewport work. The TUI
 * case — where every notch is a round trip to a program that repaints — is
 * measured by the transport tier instead.
 */
// fallow-ignore-next-line complexity -- timed scroll loop with direction reversals; the branching is the scenario under measurement.
async function localScroll(measured: Measured, notches: number): Promise<void> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
  const lines = Array.from(
    { length: SCROLLBACK },
    (_unused, index) => `line ${index} ${"scrollback ".repeat(6)}`,
  ).join("\r\n");
  await new Promise<void>((resolve) => {
    terminal.write(lines, resolve);
  });

  // Timed as one sequence, not per notch. Headless has no renderer, so a single
  // `scrollLines` is a viewport pointer move measured in tens of nanoseconds —
  // below the clock's resolution, where the reported number would be dominated
  // by timer granularity and gating it would fail on noise. The whole sequence
  // is comfortably above that floor and moves for the same reasons a per-notch
  // measurement would. Per-notch samples are still recorded raw, for inspection.
  const perNotch: number[] = [];
  let goingUp = true;
  const started = performance.now();
  for (let index = 0; index < notches; index += 1) {
    if (index > 0 && index % SCROLL_RUN === 0) goingUp = !goingUp;
    const notchStarted = performance.now();
    terminal.scrollLines(goingUp ? -SCROLL_STEP : SCROLL_STEP);
    perNotch.push(performance.now() - notchStarted);
  }
  const elapsed = performance.now() - started;
  terminal.dispose();

  measured.samples["scroll.local.notch"] = perNotch;
  measured.metrics.push({
    id: "scroll.local.sequence",
    value: elapsed,
    unit: "ms",
    class: "wall50",
    description:
      `Time to scroll ${notches} wheel notches through a full ${SCROLLBACK}-line scrollback, ` +
      `reversing direction every ${SCROLL_RUN}. No application is involved, so this is ` +
      "xterm's own viewport work — the scroll that happens when no TUI has taken the mouse.",
  });
}

/**
 * Heap cost of retaining many terminals.
 *
 * The app never unmounts a terminal once it has been activated in a pane, so
 * opening tabs over a session accumulates live xterm instances with full
 * scrollback. This does not prove that retention policy is wrong — it sizes what
 * it costs, which is what makes the argument concrete.
 */
async function retainedTerminalCost(): Promise<Metric> {
  collectGarbage();
  const before = process.memoryUsage().heapUsed;
  const terminals: Terminal[] = [];
  const filler = Array.from({ length: SCROLLBACK }, (_unused, index) => `line ${index}`).join(
    "\r\n",
  );
  for (let index = 0; index < RETAINED_TERMINALS; index += 1) {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    await new Promise<void>((resolve) => {
      terminal.write(filler, resolve);
    });
    terminals.push(terminal);
  }
  collectGarbage();
  const after = process.memoryUsage().heapUsed;
  const perTerminalKb = Math.max(0, after - before) / RETAINED_TERMINALS / 1024;
  for (const terminal of terminals) terminal.dispose();
  return {
    id: "memory.retained_terminal",
    value: perTerminalKb,
    unit: "KiB",
    class: "wall50",
    description:
      `Heap cost of one retained terminal with ${SCROLLBACK} lines of scrollback. The app ` +
      "keeps every terminal it has ever activated mounted, so this multiplies by tab count.",
  };
}

/** Forces a collection when the runtime exposes one, so the delta is meaningful. */
function collectGarbage(): void {
  const runtime = globalThis as { Bun?: { gc: (force: boolean) => void }; gc?: () => void };
  if (runtime.Bun) {
    runtime.Bun.gc(true);
    return;
  }
  runtime.gc?.();
}
