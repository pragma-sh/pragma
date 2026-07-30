/**
 * T3 — the frontend's own terminal policy.
 *
 * The transport tier measures what the server and the socket cost; the parser
 * tier measures what xterm costs. Neither can see the layer between them: the
 * GPU renderer cache that evicts past eight terminals, the mouse-wheel gate that
 * paces reports to a TUI, and the fact that a terminal is never unmounted once
 * activated. Those are what make a session with many tabs feel different from a
 * session with one, and they only do anything under jsdom with a mocked
 * `@xterm/addon-webgl` — which is why this runs inside the app's own vitest
 * project rather than from `packages/bench`.
 *
 * Nothing here paints. A headless environment has no GPU, so what is measured is
 * the *bookkeeping* — how many renderers are live, how many reports are sent —
 * which is exactly what the audit should gate on anyway. Frame timing belongs to
 * a real window and is deliberately out of scope.
 *
 * Run with `bun run bench`, never `bun run test`.
 */

import { writeFileSync } from "node:fs";

import { expect, it, vi, type Mock } from "vitest";

import type { Tab } from "@pragma/constants";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel<T> {
    onmessage: (event: T) => void = () => {};
  }
  return {
    Channel: MockChannel,
    invoke: (...args: unknown[]) => invokeMock(...args),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("@xterm/xterm", () => {
  const instances: MockTerminal[] = [];
  class MockTerminal {
    static instances = instances;
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: Record<string, unknown> = {};
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    focus = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    modes = { mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any" };
    onData = vi.fn();
    onRender = vi.fn();
    resize = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    writeln = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    refresh = vi.fn();
    scrollToBottom = vi.fn();
    dispose = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }
    open(container: HTMLElement) {
      this.element = container;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    activate = vi.fn();
  },
}));

/**
 * A renderer that records construction and disposal.
 *
 * Without this the tier measures nothing at all: the real `WebglAddon`
 * constructor throws where there is no GPU, `enableWebglRenderer` catches it and
 * silently keeps the DOM renderer, and the LRU it is supposed to populate stays
 * permanently empty. Mocking the addon is what makes the cache observable — the
 * accounting is real even though the GPU is not.
 */
vi.mock("@xterm/addon-webgl", () => {
  const instances: MockWebglAddon[] = [];
  class MockWebglAddon {
    static instances = instances;
    disposed = false;
    onContextLoss = vi.fn();
    dispose = vi.fn(() => {
      this.disposed = true;
    });
    constructor() {
      instances.push(this);
    }
  }
  return { WebglAddon: MockWebglAddon };
});

import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import {
  TERMINAL_WRITE_CHUNK_MAX_BYTES,
  TerminalManager,
  WEBGL_RENDERER_CACHE_SIZE,
} from "./terminal-manager";

interface Metric {
  id: string;
  value: number;
  unit: string;
  class: "structural" | "coalescing" | "ratio" | "throughput" | "wall50" | "wall95" | "wall99";
  description: string;
}

const SCALE = process.env.PRAGMA_BENCH_SCALE === "quick" ? "quick" : "full";
const REPS = Number(process.env.PRAGMA_BENCH_REPS ?? 7);
/** Tabs opened in the scaling cases. Well past the renderer cache size of 8. */
const TAB_COUNT = SCALE === "quick" ? 12 : 24;
/** Tabs opened and cycled in the retention case. */
const CYCLE_TABS = SCALE === "quick" ? 20 : 40;
/** Wheel reports in one uninterrupted burst. */
const WHEEL_BURST = SCALE === "quick" ? 30 : 100;

function webglInstances(): Array<{ disposed: boolean }> {
  return (WebglAddon as unknown as { instances: Array<{ disposed: boolean }> }).instances;
}

interface TerminalMock {
  onData: Mock<(...args: unknown[]) => unknown>;
  attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
  modes: { mouseTrackingMode: string };
}

function terminalInstances(): TerminalMock[] {
  return (Terminal as unknown as { instances: TerminalMock[] }).instances;
}

function liveWebglCount(): number {
  return webglInstances().filter((instance) => !instance.disposed).length;
}

function resetHarness(): void {
  webglInstances().length = 0;
  terminalInstances().length = 0;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  document.body.replaceChildren();
}

function mountTab(manager: TerminalManager, index: number): Tab {
  const tab = { id: `bench-tab-${index}`, worktreeId: "bench-wt" } as Tab;
  const element = document.createElement("div");
  document.body.append(element);
  manager.mount(tab, "/repo", element);
  return tab;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

/**
 * Opens many tabs one at a time, as a tabbed pane does: only the active tab is
 * visible, so hidden ones are eligible for eviction.
 */
function tabbedCase(): { liveMax: number; reinits: number; mountMs: number[] } {
  resetHarness();
  const manager = new TerminalManager();
  const tabs: Tab[] = [];
  const mountMs: number[] = [];
  let liveMax = 0;
  for (let index = 0; index < TAB_COUNT; index += 1) {
    for (const previous of tabs) manager.setVisible(previous.id, false);
    const started = performance.now();
    const tab = mountTab(manager, index);
    mountMs.push(performance.now() - started);
    manager.setVisible(tab.id, true);
    tabs.push(tab);
    liveMax = Math.max(liveMax, liveWebglCount());
  }
  // Cycle back through every tab; each activation of an evicted tab has to build
  // a renderer again, which is the cost a user feels as a slow tab switch.
  const before = webglInstances().length;
  for (const tab of tabs) {
    for (const other of tabs) if (other !== tab) manager.setVisible(other.id, false);
    manager.setVisible(tab.id, true);
    liveMax = Math.max(liveMax, liveWebglCount());
  }
  const reinits = webglInstances().length - before;
  for (const tab of tabs) manager.dispose(tab.id);
  return { liveMax, reinits, mountMs };
}

/**
 * Opens many tabs and leaves them all visible, as a grid of splits does.
 *
 * Eviction only ever considers a hidden terminal, so nothing here is evictable
 * and the cache size stops bounding anything.
 */
function allVisibleCase(): { live: number; liveAfterHide: number } {
  resetHarness();
  const manager = new TerminalManager();
  const tabs: Tab[] = [];
  for (let index = 0; index < TAB_COUNT; index += 1) {
    const tab = mountTab(manager, index);
    manager.setVisible(tab.id, true);
    tabs.push(tab);
  }
  const live = liveWebglCount();
  for (const tab of tabs) manager.setVisible(tab.id, false);
  const liveAfterHide = liveWebglCount();
  for (const tab of tabs) manager.dispose(tab.id);
  return { live, liveAfterHide };
}

/** Opens and cycles many tabs, then counts terminals still alive. */
function retentionCase(): number {
  resetHarness();
  const manager = new TerminalManager();
  const tabs: Tab[] = [];
  for (let index = 0; index < CYCLE_TABS; index += 1) {
    const tab = mountTab(manager, index);
    manager.setVisible(tab.id, true);
    manager.setVisible(tab.id, false);
    tabs.push(tab);
  }
  const retained = terminalInstances().length;
  for (const tab of tabs) manager.dispose(tab.id);
  return retained;
}

/**
 * Counts writes reaching the PTY from a burst of wheel reports that the
 * application never answers.
 *
 * The gate is supposed to send the first report immediately and then retain only
 * the latest while a redraw drains, so a burst collapses to a small constant. If
 * this number starts tracking the burst length, the gate stopped gating and a
 * trackpad flick is once again building a backlog the renderer has to chase.
 */
async function wheelCase(flip: boolean): Promise<number> {
  resetHarness();
  const manager = new TerminalManager();
  const tab = mountTab(manager, 0);
  await settle();
  const terminal = terminalInstances().at(-1);
  if (!terminal) throw new Error("no terminal was constructed");
  terminal.modes.mouseTrackingMode = "any";
  const onData = terminal.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;
  const onWheel = terminal.attachCustomWheelEventHandler.mock.calls[0]?.[0] as
    | ((event: WheelEvent) => boolean)
    | undefined;
  if (!onData || !onWheel) {
    throw new Error("terminal-manager did not subscribe to onData and the wheel handler");
  }

  invokeMock.mockClear();
  const down = "\x1b[<65;10;5M";
  const up = "\x1b[<64;10;5M";
  for (let index = 0; index < WHEEL_BURST; index += 1) {
    const reversed = flip && Math.floor(index / 10) % 2 === 1;
    // The wheel event has to come first. `onData` alone is *not* the gated path:
    // terminal-manager only routes a report through the gate when a real wheel
    // event was handled immediately before it, so driving `onData` on its own
    // measures the ungated fallback and reports one write per report — a number
    // that looks like a broken gate but is really a broken harness.
    onWheel(new WheelEvent("wheel", { deltaY: reversed ? -40 : 40 }));
    onData(reversed ? up : down);
  }
  await settle();
  const writes = invokeMock.mock.calls.filter((call) => call[0] === "pty_write").length;
  manager.dispose(tab.id);
  return writes;
}

function metric(
  id: string,
  value: number,
  unit: string,
  metricClass: Metric["class"],
  description: string,
): Metric {
  return { id, value, unit, class: metricClass, description };
}

function percentile(samples: number[], quantile: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

it("measures the frontend terminal policy", async () => {
  const runs: Metric[][] = [];
  const samples: Record<string, number[]> = {};

  for (let rep = 0; rep < REPS; rep += 1) {
    const tabbed = tabbedCase();
    const allVisible = allVisibleCase();
    const retained = retentionCase();
    const steadyWheelWrites = await wheelCase(false);
    const flipWheelWrites = await wheelCase(true);
    samples[`frontend.mount#rep${rep}`] = tabbed.mountMs;

    runs.push([
      metric(
        "frontend.webgl.live_contexts_tabbed",
        tabbed.liveMax,
        "count",
        "structural",
        `Most GPU renderers alive at once while cycling ${TAB_COUNT} tabs one at a time. ` +
          `Must stay within WEBGL_RENDERER_CACHE_SIZE (${WEBGL_RENDERER_CACHE_SIZE}); a rise ` +
          "means the cache stopped bounding GPU memory.",
      ),
      metric(
        "frontend.webgl.live_contexts_all_visible",
        allVisible.live,
        "count",
        "structural",
        `GPU renderers alive with ${TAB_COUNT} tabs all visible, as in a grid of splits. ` +
          "Eviction only considers hidden terminals, so nothing here is evictable and the " +
          "cache size bounds nothing — this metric is what makes that visible.",
      ),
      metric(
        "frontend.webgl.live_contexts_after_hide",
        allVisible.liveAfterHide,
        "count",
        "structural",
        `GPU renderers left after ${TAB_COUNT} visible splits become hidden. This must return ` +
          `to WEBGL_RENDERER_CACHE_SIZE (${WEBGL_RENDERER_CACHE_SIZE}) instead of retaining the ` +
          "temporary all-visible high-water mark.",
      ),
      metric(
        "frontend.webgl.reinits_per_cycle",
        tabbed.reinits,
        "count",
        "structural",
        "Renderers rebuilt while cycling once through every tab. Each one is a GPU context " +
          "created on a tab switch, which is felt as a slow switch rather than slow typing.",
      ),
      metric(
        "frontend.retained.terminals",
        retained,
        "count",
        "structural",
        `Terminals still alive after opening and leaving ${CYCLE_TABS} tabs. A terminal is ` +
          "never unmounted once activated, so this is also the number of live xterm buffers " +
          "and PTY streams a long session accumulates.",
      ),
      metric(
        "frontend.wheel.writes_per_burst",
        steadyWheelWrites,
        "count",
        "structural",
        `PTY writes produced by ${WHEEL_BURST} unanswered wheel reports. The gate should ` +
          "collapse a burst to a small constant; tracking the burst length means a trackpad " +
          "flick again builds a backlog the renderer has to chase.",
      ),
      metric(
        "frontend.wheel.writes_per_flip_burst",
        flipWheelWrites,
        "count",
        "structural",
        "The same burst with direction reversals every ten reports. Reversals are where " +
          "the gate's quiet window historically let scrolling stall.",
      ),
      metric(
        "frontend.const.webgl_cache_size",
        WEBGL_RENDERER_CACHE_SIZE,
        "count",
        "structural",
        "The app's renderer cache size, reported so a change to it is a visible, reviewed " +
          "event rather than a silent shift in what every other metric here means.",
      ),
      metric(
        "frontend.const.write_chunk_bytes",
        TERMINAL_WRITE_CHUNK_MAX_BYTES,
        "count",
        "structural",
        "The app's parser chunk size. The parser tier mirrors this value; if the two ever " +
          "diverge, this metric moves and the audit says so.",
      ),
      metric(
        "frontend.mount.p50",
        percentile(tabbed.mountMs, 0.5),
        "ms",
        "wall50",
        "Cost of mounting one more terminal. Regressing this is felt as a slow new-tab.",
      ),
      metric(
        "frontend.mount.p95",
        percentile(tabbed.mountMs, 0.95),
        "ms",
        "wall95",
        "The same, at the 95th percentile across the tabs opened.",
      ),
    ]);
  }

  // Counters reduce to the worst observation, matching `reducesToWorst` in
  // packages/bench/src/report.ts and `MetricClass::reduces_to_worst` in
  // packages/bench/src/report.rs. Wall time reduces to the best, because its
  // noise is one-sided.
  const first = runs[0];
  expect(first).toBeDefined();
  const metrics = (first ?? []).map((template) => {
    const values = runs.map(
      (run) => run.find((candidate) => candidate.id === template.id)?.value ?? template.value,
    );
    const worst = template.class === "structural" || template.class === "coalescing";
    return { ...template, value: worst ? Math.max(...values) : Math.min(...values) };
  });

  // A renderer cache that stopped bounding the tabbed case is a bug in the app,
  // not a measurement, and it should be loud here rather than only in the audit.
  const tabbedLive = metrics.find(
    (candidate) => candidate.id === "frontend.webgl.live_contexts_tabbed",
  );
  expect(tabbedLive?.value).toBeLessThanOrEqual(WEBGL_RENDERER_CACHE_SIZE);

  const out = process.env.PRAGMA_BENCH_OUT;
  if (!out) throw new Error("PRAGMA_BENCH_OUT is not set; run this through `bun run bench`");
  writeFileSync(
    out,
    JSON.stringify(
      {
        tier: `t3-${SCALE}`,
        platform: { os: process.platform, arch: process.arch },
        // The frontend tier's metrics are overwhelmingly counters, which are not
        // calibrated at all. The two wall-time metrics are reported for context
        // and given a nominal calibration of 1 so they compare raw.
        calibrationNs: 1,
        metrics,
        samples,
      },
      null,
      2,
    ),
  );
});
