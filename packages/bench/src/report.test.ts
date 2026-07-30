import { describe, expect, it } from "vitest";

import {
  audit,
  baselineKey,
  driftOf,
  higherIsBetter,
  isCalibrated,
  normalize,
  reduceRuns,
  reducesToWorst,
  summarize,
  toBaseline,
  type Baseline,
  type Metric,
  type MetricClass,
  type Report,
  type Thresholds,
} from "./report.ts";

const THRESHOLDS: Thresholds = {
  structural: { margin: 0, gate: true },
  coalescing: { margin: 0.2, gate: true },
  ratio: { margin: 0.05, gate: true },
  throughput: { margin: 0.08, gate: true },
  wall50: { margin: 0.08, gate: true },
  wall95: { margin: 0.12, gate: true },
  wall99: { margin: 0.2, gate: false },
};

const PLATFORM = { os: "linux", arch: "x86_64" };

function metric(id: string, value: number, metricClass: MetricClass): Metric {
  return { id, value, unit: "ms", class: metricClass, description: "why it matters" };
}

function report(metrics: Metric[], calibrationNs = 1000): Report {
  return { tier: "t1-full", platform: PLATFORM, calibrationNs, metrics, samples: {} };
}

function baseline(metrics: Record<string, Metric>, calibrationNs = 1000): Baseline {
  return {
    key: "ci-linux-x86_64",
    platform: PLATFORM,
    fast: false,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([id, value]) => [
        id,
        {
          value: value.value,
          class: value.class,
          tier: "t1",
          calibrationNs,
          recordedAt: "2026-01-01T00:00:00.000Z",
          commit: "abc1234",
        },
      ]),
    ),
  };
}

describe("metric classes", () => {
  it("calibrates only the classes that depend on machine speed", () => {
    expect(isCalibrated("wall95")).toBe(true);
    expect(isCalibrated("throughput")).toBe(true);
    expect(isCalibrated("structural")).toBe(false);
    expect(isCalibrated("coalescing")).toBe(false);
    expect(isCalibrated("ratio")).toBe(false);
  });

  it("treats only throughput as better when it rises", () => {
    expect(higherIsBetter("throughput")).toBe(true);
    expect(higherIsBetter("wall50")).toBe(false);
    expect(higherIsBetter("coalescing")).toBe(false);
  });

  it("reduces counters to the worst repetition and timings to the best", () => {
    expect(reducesToWorst("structural")).toBe(true);
    expect(reducesToWorst("coalescing")).toBe(true);
    expect(reducesToWorst("wall95")).toBe(false);
    expect(reducesToWorst("throughput")).toBe(false);
  });

  it("leaves an uncalibrated value alone", () => {
    // Dividing a frame count by a CPU probe would make it meaningless.
    expect(normalize(12, "structural", 5000)).toBe(12);
    expect(normalize(12, "wall50", 4)).toBe(3);
  });

  it("survives a calibration of zero rather than producing infinity", () => {
    expect(normalize(12, "wall50", 0)).toBe(12);
  });
});

describe("reduceRuns", () => {
  it("keeps the fastest observation for latency", () => {
    const runs = [
      [metric("a", 10, "wall95")],
      [metric("a", 4, "wall95")],
      [metric("a", 7, "wall95")],
    ];
    expect(reduceRuns(runs)[0]?.value).toBe(4);
  });

  it("keeps the highest observation for throughput", () => {
    const runs = [[metric("a", 10, "throughput")], [metric("a", 25, "throughput")]];
    expect(reduceRuns(runs)[0]?.value).toBe(25);
  });

  it("keeps the worst observation for counters", () => {
    // A counter that misbehaved in only one repetition must still fail the
    // audit rather than be minimised away. This mirrors the assertion in the
    // Rust tier's `counters_reduce_to_the_worst_observation`.
    for (const metricClass of ["structural", "coalescing"] as const) {
      const runs = [[metric("a", 1, metricClass)], [metric("a", 3, metricClass)]];
      expect(reduceRuns(runs)[0]?.value).toBe(3);
    }
  });

  it("tolerates a metric missing from a repetition", () => {
    const runs = [[metric("a", 5, "wall50")], [metric("b", 1, "wall50")]];
    const reduced = reduceRuns(runs);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]?.value).toBe(5);
  });

  it("returns nothing for no runs", () => {
    expect(reduceRuns([])).toEqual([]);
  });
});

describe("driftOf", () => {
  it("reports a slower latency as positive drift", () => {
    expect(driftOf({ current: 11, baseline: 10, metricClass: "wall50" })).toBeCloseTo(0.1);
  });

  it("inverts polarity so lower throughput is also positive drift", () => {
    // Folding polarity in here is what keeps the audit a single `drift > margin`
    // test for every class.
    expect(driftOf({ current: 9, baseline: 10, metricClass: "throughput" })).toBeCloseTo(0.1);
    expect(driftOf({ current: 11, baseline: 10, metricClass: "throughput" })).toBeCloseTo(-0.1);
  });

  it("treats a rise from zero as unbounded rather than dividing by zero", () => {
    expect(driftOf({ current: 1, baseline: 0, metricClass: "structural" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(driftOf({ current: 0, baseline: 0, metricClass: "structural" })).toBe(0);
  });
});

describe("audit", () => {
  it("passes a run inside every margin", () => {
    const result = audit({
      reports: [report([metric("a", 10.5, "wall50"), metric("b", 1, "structural")])],
      baseline: baseline({ a: metric("a", 10, "wall50"), b: metric("b", 1, "structural") }),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(true);
    expect(result.findings.map((finding) => finding.verdict)).toEqual(["ok", "ok"]);
  });

  it("fails a latency past its margin", () => {
    const result = audit({
      reports: [report([metric("a", 12, "wall50")])],
      baseline: baseline({ a: metric("a", 10, "wall50") }),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(false);
    expect(result.regressions[0]?.id).toBe("a");
  });

  it("fails any change at all in a structural counter", () => {
    const result = audit({
      reports: [report([metric("frames", 2, "structural")])],
      baseline: baseline({ frames: metric("frames", 1, "structural") }),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(false);
  });

  it("tolerates float round-tripping in an exactly-gated counter", () => {
    // A frame count that went through JSON must not fail on its last bit.
    const result = audit({
      reports: [report([metric("frames", 1 + 1e-15, "structural")])],
      baseline: baseline({ frames: metric("frames", 1, "structural") }),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(true);
  });

  it("normalises by calibration so a slower runner is not a regression", () => {
    // Same true cost, on a machine half as fast: both the probe and the
    // measurement doubled, so the comparison must cancel out.
    const result = audit({
      reports: [report([metric("a", 20, "wall50")], 2000)],
      baseline: baseline({ a: metric("a", 10, "wall50") }, 1000),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(true);
  });

  it("does not calibrate a counter away", () => {
    // The same counter on a machine half as fast is still the same counter.
    const result = audit({
      reports: [report([metric("frames", 1, "structural")], 2000)],
      baseline: baseline({ frames: metric("frames", 1, "structural") }, 1000),
      thresholds: THRESHOLDS,
    });
    expect(result.passed).toBe(true);
  });

  it("reports a new metric without failing", () => {
    // Adding a measurement must not break the build; it has nothing to regress
    // against yet.
    const result = audit({
      reports: [report([metric("brand.new", 5, "wall50")])],
      baseline: baseline({}),
      thresholds: THRESHOLDS,
    });
    expect(result.findings[0]?.verdict).toBe("new");
    expect(result.passed).toBe(true);
  });

  it("fails a metric the baseline expects but the run did not produce", () => {
    // This is how a silently renamed or deleted measurement is caught rather
    // than quietly reducing coverage.
    const result = audit({
      reports: [report([])],
      baseline: baseline({ gone: metric("gone", 5, "wall50") }),
      thresholds: THRESHOLDS,
    });
    expect(result.findings[0]?.verdict).toBe("missing");
    expect(result.passed).toBe(false);
  });

  it("does not accuse a single-tier run of losing another tier's metrics", () => {
    // The tight edit loop is `bun run bench --tier t3`. Without this, every
    // transport and parser metric in the baseline reports as missing, and
    // missing always fails.
    const result = audit({
      reports: [{ ...report([metric("t3.a", 1, "structural")]), tier: "t3-quick" }],
      baseline: baseline({ "t1.b": metric("t1.b", 5, "wall50") }),
      thresholds: THRESHOLDS,
      tiers: ["t3"],
    });
    expect(result.passed).toBe(true);
    expect(result.findings.map((finding) => finding.id)).toEqual(["t3.a"]);
  });

  it("still reports a missing metric from a tier that did run", () => {
    const result = audit({
      reports: [report([])],
      baseline: baseline({ "t1.b": metric("t1.b", 5, "wall50") }),
      thresholds: THRESHOLDS,
      tiers: ["t1"],
    });
    expect(result.passed).toBe(false);
    expect(result.findings[0]?.verdict).toBe("missing");
  });

  it("marks a clear improvement", () => {
    const result = audit({
      reports: [report([metric("a", 5, "wall50")])],
      baseline: baseline({ a: metric("a", 10, "wall50") }),
      thresholds: THRESHOLDS,
    });
    expect(result.findings[0]?.verdict).toBe("improved");
    expect(result.passed).toBe(true);
  });

  it("audits every tier against one baseline", () => {
    const result = audit({
      reports: [report([metric("t1.a", 10, "wall50")]), report([metric("t3.b", 1, "structural")])],
      baseline: baseline({ "t1.a": metric("t1.a", 10, "wall50") }),
      thresholds: THRESHOLDS,
    });
    expect(result.findings.map((finding) => finding.id)).toEqual(["t1.a", "t3.b"]);
  });
});

describe("baselineKey", () => {
  it("separates CI from local", () => {
    // A laptop and a CI runner are not comparable even after calibration: they
    // differ in core count, thermal behaviour, and background load.
    expect(baselineKey({ environment: "ci", platform: PLATFORM })).toBe("ci-linux-x86_64");
    expect(baselineKey({ environment: "local", platform: PLATFORM })).toBe("local-linux-x86_64");
  });
});

describe("toBaseline", () => {
  it("records every metric with the calibration it was measured against", () => {
    const recorded = toBaseline({
      reports: [report([metric("a", 10, "wall50")], 1234)],
      key: "ci-linux-x86_64",
      platform: PLATFORM,
      commit: "abc1234",
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(recorded.metrics["a"]).toEqual({
      value: 10,
      class: "wall50",
      tier: "t1",
      calibrationNs: 1234,
      recordedAt: "2026-07-30T00:00:00.000Z",
      commit: "abc1234",
    });
  });

  it("round-trips through the audit as a pass", () => {
    const reports = [report([metric("a", 10, "wall50"), metric("b", 3, "structural")])];
    const recorded = toBaseline({
      reports,
      key: "ci-linux-x86_64",
      platform: PLATFORM,
      commit: "abc1234",
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(audit({ reports, baseline: recorded, thresholds: THRESHOLDS }).passed).toBe(true);
  });
});

describe("summarize", () => {
  it("reports observed values rather than interpolating", () => {
    expect(summarize([1, 1, 1, 100]).p95).toBe(100);
  });

  it("handles no samples", () => {
    expect(summarize([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it("computes percentiles of a known distribution", () => {
    const samples = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(summarize(samples)).toEqual({ p50: 50, p95: 95, p99: 99 });
  });
});
