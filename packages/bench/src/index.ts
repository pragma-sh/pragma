/**
 * `bun run bench` — runs every benchmark tier and audits the result.
 *
 * The tiers are separate processes and separate languages because they measure
 * different things honestly:
 *
 * - **T1** (`pragma-bench`, Rust) drives a real `pragma-server` over a real
 *   local socket. Transport: hops 4-7.
 * - **T2** (`parser.ts`, here) feeds the same corpora to xterm's parser. Hop 8.
 * - **T3** (`apps/pragma/src/**\/*.bench.ts`) drives the frontend's own policy
 *   under the app's vitest setup, where `@xterm/addon-webgl` is already mocked
 *   and jsdom is already configured. Renderer cache, wheel gate, retention.
 *
 * Every tier emits the same {@link Report} shape and they are audited together
 * against one baseline file.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { calibrateNs } from "./calibrate.ts";
import { runParserTier, type CorpusKind } from "./parser.ts";
import {
  audit,
  baselineKey,
  reduceRuns,
  toBaseline,
  type Audit,
  type Baseline,
  type Finding,
  type Platform,
  type Report,
  type Thresholds,
} from "./report.ts";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const BASELINE_DIR = join(PACKAGE_DIR, "baselines");
const REPORT_DIR = join(PACKAGE_DIR, "reports");

/** Bytes of each corpus fed to the parser tier. */
const PARSER_BYTES = { quick: 1024 * 1024, full: 4 * 1024 * 1024 } as const;
/** Wheel notches in the local-scroll case. */
const SCROLL_NOTCHES = { quick: 60, full: 200 } as const;

type Scale = "quick" | "full";

interface Options {
  scale: Scale;
  reps: number;
  environment: "ci" | "local";
  mode: "compare" | "audit" | "record";
  json: string | null;
  tiers: Set<string>;
  /** Build with the iteration-speed Cargo profile instead of release. */
  fast: boolean;
  /**
   * Explicit baseline file, overriding the environment's default location.
   *
   * This is what makes an A/B comparison clean: record "before" to a scratch
   * path, make the change, then compare against that path. Without it a
   * `--record` would clobber the environment's baseline and the "before"
   * measurement would be gone.
   */
  baseline: string | null;
}

const ALL_TIERS = ["t1", "t2", "t3"] as const;

// fallow-ignore-next-line complexity -- CLI flag parser: each option is an independent branch; extracting helpers would not reduce essential branching.
function parseOptions(argv: string[]): Options {
  const valueOf = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at >= 0 ? (argv[at + 1] ?? null) : null;
  };
  const scale = (valueOf("--scale") ?? "full") as Scale;
  if (scale !== "quick" && scale !== "full") {
    throw new Error(`unknown --scale ${scale}; expected quick or full`);
  }
  const reps = Number(valueOf("--reps") ?? 7);
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error("--reps must be a positive integer");
  }
  const requested = valueOf("--tier");
  const tiers = new Set(requested ? [requested] : ALL_TIERS);
  for (const tier of tiers) {
    if (!ALL_TIERS.includes(tier as (typeof ALL_TIERS)[number])) {
      throw new Error(`unknown --tier ${tier}; expected one of ${ALL_TIERS.join(", ")}`);
    }
  }
  const fast = argv.includes("--fast");
  const mode = argv.includes("--record")
    ? "record"
    : argv.includes("--audit")
      ? "audit"
      : "compare";
  const baselineOverride = valueOf("--baseline");
  if (fast && mode === "record" && !baselineOverride) {
    // A fast-profile number is not comparable to a release one, so recording
    // one over the environment's durable baseline would make every later
    // release-profile run look like a regression. An explicit --baseline is a
    // different thing: it is how an A/B comparison records its "before", and
    // both sides of that comparison use the same profile.
    throw new Error(
      "--fast will not overwrite the environment baseline; " +
        "pass --baseline PATH to record a scratch one for an A/B comparison",
    );
  }
  return {
    scale,
    reps,
    environment: argv.includes("--ci") ? "ci" : "local",
    mode,
    json: valueOf("--json"),
    tiers,
    fast,
    baseline: baselineOverride,
  };
}

function usage(): string {
  return [
    "bun run bench — Pragma terminal latency benchmark",
    "",
    "Options:",
    "  --scale quick|full  Work per scenario (default: full)",
    "  --reps N            Repetitions to reduce over (default: 7)",
    "  --tier t1|t2|t3     Run only one tier (t3 needs no Cargo build at all)",
    "  --fast              Build Rust with the bench-fast profile: ~10s incremental",
    "                      instead of ~48s, at the cost of numbers that are not",
    "                      comparable to release. Cannot record a baseline.",
    "  --ci                Use the committed CI baseline instead of the local one",
    "  --audit             Exit non-zero if anything regressed past its margin",
    "  --record            Overwrite the baseline for this environment",
    "  --baseline PATH     Read/write this baseline file instead of the default.",
    "                      Use it for A/B: --record --baseline /tmp/before.json,",
    "                      make the change, then --baseline /tmp/before.json.",
    "  --json PATH         Write the merged report here: raw per-repetition",
    "                      samples plus every metric's drift verdict.",
    "",
    "Baselines live in packages/bench/baselines; raw reports in packages/bench/reports.",
  ].join("\n");
}

/** Runs a command, inheriting stderr so progress is visible, and returns stdout. */
function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: "buffer",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}`);
  }
  return result.stdout;
}

/**
 * Builds the Rust binaries the transport tier needs.
 *
 * Only `pragma-bench` and `pragma-server` — never the Tauri app. The desktop
 * crate is not in this dependency graph, so no webview, no frontend bundle, and
 * no sidecar staging is involved in a benchmark run.
 */
function buildRust(options: Options): { bench: string; load: string } {
  const profile = options.fast ? "bench-fast" : "release";
  console.error(`bench: building pragma-bench and pragma-server (${profile})`);
  run("cargo", ["build", "--profile", profile, "-p", "pragma-bench", "-p", "pragma-server"], {});
  const target = join(REPO_ROOT, "target", profile);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return {
    bench: join(target, `pragma-bench${suffix}`),
    load: join(target, `pragma-bench-load${suffix}`),
  };
}

/** Runs the Rust transport tier, which reduces its own repetitions internally. */
function runTransportTier(binaries: { bench: string }, options: Options): Report {
  const out = join(REPORT_DIR, "t1.json");
  mkdirSync(REPORT_DIR, { recursive: true });
  run(binaries.bench, ["--scale", options.scale, "--reps", String(options.reps), "--out", out], {});
  return JSON.parse(readFileSync(out, "utf8")) as Report;
}

/** Runs the parser tier, reducing repetitions here. */
async function runParser(binaries: { load: string }, options: Options): Promise<Report> {
  const bytes = PARSER_BYTES[options.scale];
  const corpusFor = async (kind: CorpusKind): Promise<Uint8Array> =>
    new Uint8Array(run(binaries.load, ["corpus", "--kind", kind, "--bytes", String(bytes)], {}));

  const runs = [];
  const calibrations = [];
  const samples: Record<string, number[]> = {};
  for (let rep = 0; rep < options.reps; rep += 1) {
    console.error(`bench: parser tier repetition ${rep + 1} of ${options.reps}`);
    calibrations.push(calibrateNs());
    const measured = await runParserTier({
      corpusFor,
      scrollNotches: SCROLL_NOTCHES[options.scale],
    });
    for (const [prefix, values] of Object.entries(measured.samples)) {
      samples[`${prefix}#rep${rep}`] = values;
    }
    runs.push(measured.metrics);
  }
  return {
    tier: `t2-${options.scale}`,
    platform: detectPlatform(),
    calibrationNs: Math.min(...calibrations),
    metrics: reduceRuns(runs),
    samples,
  };
}

/**
 * Runs the frontend tier inside the app's own vitest project.
 *
 * It has to run there, not here: the policy under measurement lives in
 * `terminal-manager.ts`, which needs jsdom and a mocked `@xterm/addon-webgl`
 * before its renderer cache does anything at all. Both are already configured
 * in `apps/pragma`, and reaching into the app from this package would invert the
 * dependency direction for no benefit.
 */
function runFrontendTier(options: Options): Report {
  const out = join(REPORT_DIR, "t3.json");
  mkdirSync(REPORT_DIR, { recursive: true });
  console.error("bench: frontend tier");
  run("bun", ["--bun", "vitest", "run", "--config", "vitest.bench.config.ts"], {
    cwd: join(REPO_ROOT, "apps", "pragma"),
    env: {
      PRAGMA_BENCH_OUT: out,
      PRAGMA_BENCH_SCALE: options.scale,
      PRAGMA_BENCH_REPS: String(options.reps),
    },
  });
  return JSON.parse(readFileSync(out, "utf8")) as Report;
}

/**
 * Names the platform the way the Rust tier does, so both tiers key into the same
 * baseline file. Anything unrecognised falls through under its Node spelling,
 * which is wrong-looking rather than silently merged with another platform's
 * baseline.
 */
function detectPlatform(): Platform {
  const osNames: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" };
  const archNames: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
  return {
    os: osNames[process.platform] ?? process.platform,
    arch: archNames[process.arch] ?? process.arch,
  };
}

function loadThresholds(): Thresholds {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, "thresholds.json"), "utf8")) as Thresholds;
}

function baselinePath(key: string, options: Options): string {
  if (options.baseline) return options.baseline;
  return options.environment === "ci"
    ? join(BASELINE_DIR, `${key}.json`)
    : join(BASELINE_DIR, "local", `${key}.json`);
}

/**
 * Reads a baseline, or an empty one when the file is absent.
 *
 * An empty baseline is not an error: the first run on a new machine, or the
 * first run after a metric is added, has nothing to compare against and should
 * print its numbers rather than fail.
 */
function loadBaseline(path: string, key: string, platform: Platform, fast: boolean): Baseline {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch {
    return { key, platform, fast, metrics: {} };
  }
}

function currentCommit(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.stdout?.trim() || "unknown";
}

/** Renders the audit as a table, widest column first so it stays readable. */
function renderTable(result: Audit): string {
  // fallow-ignore-next-line complexity -- display formatting ternaries for NaN/null/gated columns; not extractable domain logic.
  const rows = result.findings.map((finding) => ({
    id: finding.id,
    current: Number.isNaN(finding.current) ? "—" : format(finding.current),
    baseline: finding.baseline === null ? "—" : format(finding.baseline),
    drift: finding.baseline === null ? "—" : formatDrift(finding.drift),
    margin: `${finding.margin === 0 ? "exact" : `±${(finding.margin * 100).toFixed(0)}%`}${
      finding.gated ? "" : "*"
    }`,
    verdict: finding.verdict,
    unit: finding.unit,
  }));
  const widths = {
    id: Math.max(6, ...rows.map((row) => row.id.length)),
    current: Math.max(7, ...rows.map((row) => row.current.length)),
    baseline: Math.max(8, ...rows.map((row) => row.baseline.length)),
    drift: Math.max(5, ...rows.map((row) => row.drift.length)),
  };
  const lines = [
    `${"metric".padEnd(widths.id)}  ${"current".padStart(widths.current)}  ${"baseline".padStart(widths.baseline)}  ${"drift".padStart(widths.drift)}  margin   verdict`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(widths.id)}  ${row.current.padStart(widths.current)}  ${row.baseline.padStart(widths.baseline)}  ${row.drift.padStart(widths.drift)}  ${row.margin.padStart(7)}  ${row.verdict}`,
    );
  }
  return lines.join("\n");
}

function format(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function formatDrift(drift: number): string {
  if (!Number.isFinite(drift)) return "—";
  const percent = drift * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

/** Explains why each regression matters, so a red build is actionable. */
function explain(regressions: Finding[]): string {
  return regressions
    .map(
      (finding) =>
        `  ${finding.id}: ${formatDrift(finding.drift)} against a ${
          finding.margin === 0 ? "exact" : `±${(finding.margin * 100).toFixed(0)}%`
        } margin\n    ${finding.description}`,
    )
    .join("\n");
}

// fallow-ignore-next-line complexity -- orchestrates tier selection, baseline load/record, and audit reporting in one CLI entrypoint.
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const options = parseOptions(argv);
  const reports: Report[] = [];
  const needsRust = options.tiers.has("t1") || options.tiers.has("t2");
  const binaries = needsRust ? buildRust(options) : { bench: "", load: "" };
  if (options.fast) {
    console.error(
      "bench: --fast profile — timings are not comparable to release; " +
        "structural counters still are",
    );
  }

  if (options.tiers.has("t1")) reports.push(runTransportTier(binaries, options));
  if (options.tiers.has("t2")) reports.push(await runParser(binaries, options));
  if (options.tiers.has("t3")) reports.push(runFrontendTier(options));

  const platform = detectPlatform();
  const key = baselineKey({ environment: options.environment, platform });
  const commit = currentCommit();
  const recordedAt = new Date().toISOString();

  mkdirSync(REPORT_DIR, { recursive: true });
  const rawPath =
    options.json ?? join(REPORT_DIR, `${recordedAt.replace(/[:.]/g, "-")}-${commit}.json`);
  const writeReport = (extra: Record<string, unknown>): void => {
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(
      rawPath,
      JSON.stringify({ key, commit, recordedAt, fast: options.fast, reports, ...extra }, null, 2),
    );
    console.error(`bench: report written to ${rawPath}`);
  };

  if (options.mode === "record") {
    writeReport({});
    const path = baselinePath(key, options);
    mkdirSync(dirname(path), { recursive: true });
    const baseline = toBaseline({
      reports,
      key,
      platform,
      commit,
      recordedAt,
      fast: options.fast,
    });
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`bench: recorded ${Object.keys(baseline.metrics).length} metrics to ${path}`);
    return 0;
  }

  const path = baselinePath(key, options);
  const baseline = loadBaseline(path, key, platform, options.fast);
  if (Object.keys(baseline.metrics).length > 0 && baseline.fast !== options.fast) {
    console.error(
      `bench: WARNING — this run used the ${options.fast ? "bench-fast" : "release"} profile ` +
        `but ${path} was recorded with ${baseline.fast ? "bench-fast" : "release"}. ` +
        "Timing drift below is mostly the optimiser, not your change.",
    );
  }
  const result = audit({
    reports,
    baseline,
    thresholds: loadThresholds(),
    // Scope the missing-metric check to the tiers this run produced, so
    // `--tier t3` in a tight edit loop is not accused of deleting every
    // transport and parser metric in the baseline.
    tiers: [...options.tiers],
  });
  // The audit goes into the report alongside the raw samples so a caller does
  // not have to re-derive drift by diffing two files, or scrape the table.
  writeReport({ audit: result });
  console.log(renderTable(result));
  if (Object.keys(baseline.metrics).length === 0) {
    console.log(`\nbench: no baseline recorded at ${path} yet; run with --record`);
    return 0;
  }
  const reportOnly = result.findings.filter(
    (finding) => !finding.gated && finding.verdict === "regressed",
  );
  if (reportOnly.length > 0) {
    console.log(
      `\nbench: ${reportOnly.length} report-only metric(s) past their margin (marked * above); ` +
        "not gated, so they do not fail the run:\n" +
        reportOnly.map((finding) => `  ${finding.id}: ${formatDrift(finding.drift)}`).join("\n"),
    );
  }
  if (result.passed) {
    console.log(`\nbench: ${result.findings.length} metrics, no gated regressions`);
    return 0;
  }
  console.log(
    `\nbench: ${result.regressions.length} regression(s)\n${explain(result.regressions)}`,
  );
  return options.mode === "audit" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    return code;
  })
  .catch((error: unknown) => {
    console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
