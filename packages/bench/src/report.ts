/**
 * The report shape every benchmark tier emits, and the audit that compares a
 * run against a recorded baseline.
 *
 * Mirrors `src/report.rs` — the Rust tier serialises exactly this shape, so a
 * change here has to be made there too.
 */

/**
 * How noisy a metric is, which is what decides the margin the audit allows.
 *
 * A single blanket margin would have to be as loose as the worst metric, which
 * would let real regressions through everywhere else. Splitting metrics by
 * noise class is what lets a counter be gated exactly while a p99 — one sample,
 * owned by whichever scheduler decision was unluckiest — gets a wide band.
 */
export type MetricClass =
  | "structural"
  | "coalescing"
  | "ratio"
  | "throughput"
  | "wall50"
  | "wall95"
  | "wall99";

/** Classes divided by the calibration scalar before comparison. */
const CALIBRATED: ReadonlySet<MetricClass> = new Set<MetricClass>([
  "throughput",
  "wall50",
  "wall95",
  "wall99",
]);

/** Classes where a larger value is an improvement rather than a regression. */
const HIGHER_IS_BETTER: ReadonlySet<MetricClass> = new Set<MetricClass>(["throughput"]);

/** Whether the audit normalises this class by machine speed. */
export function isCalibrated(metricClass: MetricClass): boolean {
  return CALIBRATED.has(metricClass);
}

/** Whether a rise in this class is an improvement. */
export function higherIsBetter(metricClass: MetricClass): boolean {
  return HIGHER_IS_BETTER.has(metricClass);
}

/** Classes that reduce to the worst repetition rather than the best. */
const REDUCES_TO_WORST: ReadonlySet<MetricClass> = new Set<MetricClass>([
  "structural",
  "coalescing",
]);

/**
 * Whether repetitions reduce to the worst observation instead of the best.
 *
 * Wall time and throughput reduce to the best a machine managed, because their
 * noise is one-sided — a bad scheduling decision can only make an operation
 * slower than its true cost, never faster — so the best run is the closest
 * estimate available. Counters are different: they are supposed to be identical
 * every repetition, so a repetition that disagreed found something real and must
 * not be minimised away.
 *
 * The Rust tier states this same rule in `MetricClass::reduces_to_worst`. The
 * two implementations are kept honest by unit tests that assert the same cases
 * on both sides.
 */
export function reducesToWorst(metricClass: MetricClass): boolean {
  return REDUCES_TO_WORST.has(metricClass);
}

/**
 * Reduces repeated runs of the same metrics into one value each.
 *
 * Metrics are matched by id, so a run that failed to produce one simply does
 * not contribute to it.
 */
export function reduceRuns(runs: Metric[][]): Metric[] {
  const first = runs[0];
  if (!first) return [];
  const out = first.map((metric) => ({ ...metric }));
  for (const run of runs.slice(1)) {
    const byId = new Map(run.map((metric) => [metric.id, metric]));
    for (const metric of out) {
      const candidate = byId.get(metric.id);
      if (!candidate) continue;
      const preferHigher = higherIsBetter(metric.class) || reducesToWorst(metric.class);
      if (preferHigher === candidate.value > metric.value) {
        metric.value = candidate.value;
      }
    }
  }
  return out;
}

/** One measured value. */
export interface Metric {
  /** Dotted, stable identifier — `typing.paced.echo.p95`. */
  id: string;
  value: number;
  /** Display unit: `ms`, `MB/s`, `count`, or `ratio`. */
  unit: string;
  class: MetricClass;
  /** One line explaining what regressing this metric would mean for a user. */
  description: string;
}

/** The environment a report was produced on. Baselines are keyed by this. */
export interface Platform {
  os: string;
  arch: string;
}

/** One tier's results. */
export interface Report {
  tier: string;
  platform: Platform;
  /**
   * Nanoseconds the calibration probe took. Calibrated metrics are compared as
   * `value / calibrationNs`, so a faster or slower runner moves both the probe
   * and the measurement together and a recorded baseline stays valid.
   */
  calibrationNs: number;
  metrics: Metric[];
  /** Every individual observation, keyed by metric prefix. Never gated. */
  samples: Record<string, number[]>;
}

/** One tier's contribution to a report, before repetitions are reduced. */
export interface Measured {
  metrics: Metric[];
  samples: Record<string, number[]>;
}

/** Percentiles of one measured quantity. */
export interface Summary {
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank percentiles, so a reported p99 is always a value that was
 * actually observed rather than one interpolated between two samples.
 */
export function summarize(samples: number[]): Summary {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Records a latency distribution's percentiles plus its raw samples. */
export function pushLatency(
  into: Measured,
  prefix: string,
  samples: number[],
  description: string,
): void {
  const summary = summarize(samples);
  const classes: [string, number, MetricClass][] = [
    ["p50", summary.p50, "wall50"],
    ["p95", summary.p95, "wall95"],
    ["p99", summary.p99, "wall99"],
  ];
  for (const [suffix, value, metricClass] of classes) {
    into.metrics.push({
      id: `${prefix}.${suffix}`,
      value,
      unit: "ms",
      class: metricClass,
      description,
    });
  }
  into.samples[prefix] = samples;
}

/** One recorded expectation. */
export interface BaselineEntry {
  value: number;
  class: MetricClass;
  /**
   * The tier that produced it (`t1`, `t2`, `t3`).
   *
   * Recorded so a run scoped to one tier is not accused of losing every metric
   * the other tiers own — see the `tiers` option on {@link audit}.
   */
  tier: string;
  /** The calibration the value was recorded against. */
  calibrationNs: number;
  recordedAt: string;
  commit: string;
}

/** Everything expected of one environment. */
export interface Baseline {
  key: string;
  platform: Platform;
  /**
   * Whether it was recorded with the iteration-speed Cargo profile.
   *
   * Recorded so a comparison across profiles is caught and reported rather than
   * quietly showing tens of percent of drift that is only the optimiser.
   */
  fast: boolean;
  metrics: Record<string, BaselineEntry>;
}

/** What the audit allows, and whether exceeding it fails the build. */
export interface Threshold {
  /** Allowed drift as a fraction. Zero means exact. */
  margin: number;
  /**
   * Whether exceeding the margin fails the run.
   *
   * Report-only classes still appear in the table with their drift, so a real
   * regression is visible and reviewable — they just do not turn the build red.
   * This is for metrics whose run-to-run spread is not yet known well enough to
   * gate: a threshold guessed from one recording session produces a check that
   * goes red for no reason, gets ignored, and then misses the regression it
   * existed for. Promote a class to gated once recorded baselines show what its
   * real spread is.
   */
  gate: boolean;
}

/** Allowed drift per class. */
export type Thresholds = Record<MetricClass, Threshold>;

/** What the audit concluded about one metric. */
export type Verdict = "ok" | "regressed" | "improved" | "new" | "missing";

/** One metric's audit result. */
export interface Finding {
  id: string;
  verdict: Verdict;
  unit: string;
  metricClass: MetricClass;
  /** Whether exceeding the margin fails the run. */
  gated: boolean;
  /** Raw measured value, in the metric's own unit. */
  current: number;
  /** Recorded value, in the metric's own unit. `null` for a new metric. */
  baseline: number | null;
  /**
   * Fractional change after calibration, signed so that positive always means
   * "moved in the worse direction" regardless of the metric's polarity.
   */
  drift: number;
  margin: number;
  description: string;
}

/** The whole audit. */
export interface Audit {
  key: string;
  findings: Finding[];
  regressions: Finding[];
  /** True when nothing regressed. */
  passed: boolean;
}

/**
 * The baseline key for an environment.
 *
 * `ci` and `local` are separate files on purpose: a developer's laptop and a CI
 * runner produce numbers that are not comparable even after calibration,
 * because they differ in core count, thermal behaviour, and background load —
 * not just raw speed.
 */
export function baselineKey(options: { environment: "ci" | "local"; platform: Platform }): string {
  const { environment, platform } = options;
  return `${environment}-${platform.os}-${platform.arch}`;
}

/**
 * Normalises a value by machine speed, when its class calls for it.
 *
 * Uncalibrated classes (counters and ratios) are returned unchanged: dividing a
 * frame count by a CPU probe would make it meaningless.
 */
export function normalize(value: number, metricClass: MetricClass, calibrationNs: number): number {
  if (!isCalibrated(metricClass) || calibrationNs <= 0) return value;
  return value / calibrationNs;
}

/**
 * Signed drift, where positive always means worse.
 *
 * Folding polarity in here rather than at each call site is what keeps the
 * audit's comparison a single `drift > margin` test for every class, including
 * throughput where the regression direction is inverted.
 */
export function driftOf(options: {
  current: number;
  baseline: number;
  metricClass: MetricClass;
}): number {
  const { current, baseline, metricClass } = options;
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  const change = (current - baseline) / Math.abs(baseline);
  return higherIsBetter(metricClass) ? -change : change;
}

/**
 * Compares a run against a baseline.
 *
 * A metric absent from the baseline is reported as `new` and never fails: a
 * newly added measurement has nothing to regress against, and failing on it
 * would mean every scenario addition breaks the build. A metric present in the
 * baseline but absent from the run is reported as `missing`, which *does* fail —
 * that is how a silently deleted or renamed measurement is caught rather than
 * quietly reducing coverage.
 */
// fallow-ignore-next-line complexity -- compares every metric against baseline with new/missing/regressed/improved branches; splitting would hide the single-pass audit invariant.
export function audit(options: {
  reports: Report[];
  baseline: Baseline;
  thresholds: Thresholds;
  /**
   * Tiers this run actually produced (`["t1"]`, …). Baseline entries belonging
   * to a tier that did not run are skipped rather than reported as missing.
   * Omit to check every recorded metric, which is what a full run wants.
   */
  tiers?: string[];
}): Audit {
  const { reports, baseline, thresholds } = options;
  const ranTiers = options.tiers ? new Set(options.tiers) : null;
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    for (const metric of report.metrics) {
      seen.add(metric.id);
      const recorded = baseline.metrics[metric.id];
      const threshold = thresholds[metric.class] ?? { margin: 0, gate: false };
      const margin = threshold.margin;
      if (!recorded) {
        findings.push({
          id: metric.id,
          verdict: "new",
          unit: metric.unit,
          metricClass: metric.class,
          gated: threshold.gate,
          current: metric.value,
          baseline: null,
          drift: 0,
          margin,
          description: metric.description,
        });
        continue;
      }
      const current = normalize(metric.value, metric.class, report.calibrationNs);
      const previous = normalize(recorded.value, metric.class, recorded.calibrationNs);
      const drift = driftOf({ current, baseline: previous, metricClass: metric.class });
      // Exact classes still need a tolerance for float representation; a frame
      // count that round-tripped through JSON must not fail on its last bit.
      const exceeded = margin === 0 ? Math.abs(drift) > 1e-9 : drift > margin;
      const improved = margin > 0 && drift < -margin;
      findings.push({
        id: metric.id,
        verdict: exceeded ? "regressed" : improved ? "improved" : "ok",
        unit: metric.unit,
        metricClass: metric.class,
        gated: threshold.gate,
        current: metric.value,
        baseline: recorded.value,
        drift,
        margin,
        description: metric.description,
      });
    }
  }

  for (const [id, recorded] of Object.entries(baseline.metrics)) {
    if (seen.has(id)) continue;
    // A tier that did not run cannot have lost anything.
    if (ranTiers && !ranTiers.has(tierOf(recorded.tier))) continue;
    findings.push({
      id,
      verdict: "missing",
      unit: "",
      metricClass: recorded.class,
      // A metric the baseline expects but the run never produced always fails,
      // whatever its class allows: it means a measurement was renamed or deleted
      // and coverage silently shrank.
      gated: true,
      current: Number.NaN,
      baseline: recorded.value,
      drift: Number.POSITIVE_INFINITY,
      margin: thresholds[recorded.class]?.margin ?? 0,
      description: "Recorded in the baseline but not produced by this run.",
    });
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));
  const regressions = findings.filter(
    (finding) =>
      finding.gated && (finding.verdict === "regressed" || finding.verdict === "missing"),
  );
  return {
    key: baseline.key,
    findings,
    regressions,
    passed: regressions.length === 0,
  };
}

/** The tier family of a tier string: `t1-quick` → `t1`. */
export function tierOf(tier: string): string {
  return tier.split("-")[0] ?? tier;
}

/** Builds a baseline from a set of reports. */
export function toBaseline(options: {
  reports: Report[];
  key: string;
  platform: Platform;
  commit: string;
  recordedAt: string;
  fast?: boolean;
}): Baseline {
  const { reports, key, platform, commit, recordedAt } = options;
  const metrics: Record<string, BaselineEntry> = {};
  for (const report of reports) {
    for (const metric of report.metrics) {
      metrics[metric.id] = {
        value: metric.value,
        class: metric.class,
        tier: tierOf(report.tier),
        calibrationNs: report.calibrationNs,
        recordedAt,
        commit,
      };
    }
  }
  return { key, platform, fast: options.fast ?? false, metrics };
}
