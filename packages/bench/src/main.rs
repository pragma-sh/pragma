//! `pragma-bench` — the T1 (transport) tier of Pragma's terminal benchmark.
//!
//! Runs each scenario several times against a freshly started `pragma-server`
//! and reduces the repetitions before reporting. The reduction is a **minimum**,
//! not an average: measurement noise on a shared runner is one-sided — a bad
//! scheduling decision can only make an operation slower than its true cost,
//! never faster — so the minimum is the least contaminated estimate available,
//! and it is what allows the audit's margins to be tight enough to catch a real
//! regression rather than only a catastrophic one.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use pragma_bench::harness::{sibling_executable, BenchResult, BenchServer};
use pragma_bench::report::{calibrate, Metric, Platform, Report};
use pragma_bench::scenarios::{firehose, scroll, tabs, typing, Config, Measured, Scale};

/// Default repetitions. Seven is enough for the minimum to be stable without
/// making the job long enough that people start skipping it.
const DEFAULT_REPS: usize = 7;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pragma-bench: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Ok(());
    }
    let options = Options::parse(&args)?;
    let report = measure(&options).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    if let Some(path) = &options.out {
        return std::fs::write(path, json).map_err(|error| error.to_string());
    }
    println!("{json}");
    Ok(())
}

fn print_help() {
    println!(
        "pragma-bench — terminal transport benchmark (T1)\n\
         \n\
         Usage: pragma-bench [options]\n\
         \n\
         Options:\n\
         \x20 --scale quick|full   Work per scenario (default: full)\n\
         \x20 --reps N             Repetitions to reduce over (default: {DEFAULT_REPS})\n\
         \x20 --scenario NAME      Run only one of: typing, firehose, scroll, tabs\n\
         \x20 --server-bin PATH    pragma-server executable (default: next to this one)\n\
         \x20 --load-bin PATH      pragma-bench-load executable (default: next to this one)\n\
         \x20 --out PATH           Write the JSON report here instead of stdout\n"
    );
}

struct Options {
    scale: Scale,
    reps: usize,
    scenario: Option<String>,
    server_bin: PathBuf,
    load_bin: PathBuf,
    out: Option<PathBuf>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let scale = match value_of(args, "--scale") {
            None => Scale::Full,
            Some(raw) => Scale::parse(&raw).ok_or_else(|| format!("unknown scale {raw:?}"))?,
        };
        let reps = match value_of(args, "--reps") {
            None => DEFAULT_REPS,
            Some(raw) => raw
                .parse()
                .map_err(|_| format!("--reps expects a number, got {raw:?}"))?,
        };
        if reps == 0 {
            return Err("--reps must be at least 1".to_string());
        }
        let scenario = value_of(args, "--scenario");
        if let Some(name) = &scenario {
            if !SCENARIOS.contains(&name.as_str()) {
                return Err(format!(
                    "unknown scenario {name:?}; expected one of {}",
                    SCENARIOS.join(", ")
                ));
            }
        }
        let server_bin = match value_of(args, "--server-bin") {
            Some(path) => PathBuf::from(path),
            None => sibling_executable("pragma-server").map_err(|error| error.to_string())?,
        };
        let load_bin = match value_of(args, "--load-bin") {
            Some(path) => PathBuf::from(path),
            None => sibling_executable("pragma-bench-load").map_err(|error| error.to_string())?,
        };
        Ok(Self {
            scale,
            reps,
            scenario,
            server_bin,
            load_bin,
            out: value_of(args, "--out").map(PathBuf::from),
        })
    }

    fn wants(&self, scenario: &str) -> bool {
        self.scenario
            .as_ref()
            .is_none_or(|selected| selected == scenario)
    }
}

const SCENARIOS: [&str; 4] = ["typing", "firehose", "scroll", "tabs"];

fn value_of(args: &[String], flag: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == flag)?;
    args.get(at + 1).cloned()
}

/// Runs every repetition and reduces them into one report.
fn measure(options: &Options) -> BenchResult<Report> {
    let config = Config {
        load_bin: options.load_bin.clone(),
        scale: options.scale,
    };
    let mut reps: Vec<Vec<Metric>> = Vec::with_capacity(options.reps);
    let mut samples: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut calibrations: Vec<u64> = Vec::with_capacity(options.reps);

    for rep in 0..options.reps {
        eprintln!("pragma-bench: repetition {} of {}", rep + 1, options.reps);
        calibrations.push(calibrate());
        // A fresh server per repetition: a leaked session or a warmed cache from
        // an earlier repetition would make later ones incomparable, which is
        // exactly what a minimum-reduction is most sensitive to.
        let server = BenchServer::start(&options.server_bin)?;
        let mut measured = Measured::default();
        if options.wants("typing") {
            measured.absorb(typing::run(&server, &config)?);
        }
        if options.wants("firehose") {
            measured.absorb(firehose::run(&server, &config)?);
        }
        if options.wants("scroll") {
            measured.absorb(scroll::run(&server, &config)?);
        }
        if options.wants("tabs") {
            measured.absorb(tabs::run(&server, &config)?);
        }
        // Raw observations are kept per repetition rather than merged, so a
        // histogram or a per-run comparison can be rebuilt later without
        // re-running anything.
        for (prefix, values) in measured.samples {
            samples.insert(format!("{prefix}#rep{rep}"), values);
        }
        reps.push(measured.metrics);
    }

    Ok(Report {
        tier: format!("t1-{}", options.scale.name()),
        platform: Platform::detect(),
        // The calibration probe is itself subject to the same one-sided noise,
        // so reduce it the same way the metrics are reduced.
        calibration_ns: calibrations.into_iter().min().unwrap_or(1),
        metrics: reduce(&reps),
        samples,
    })
}

/// Reduces per-repetition metrics into one value each.
///
/// Latency takes the minimum and throughput the maximum — both meaning "the
/// best this machine managed", which is the closest available estimate of the
/// true cost. Structural counters take the maximum instead: they are supposed to
/// be identical across repetitions, so if they are not, the run that showed the
/// worst behaviour is the one worth failing on.
fn reduce(reps: &[Vec<Metric>]) -> Vec<Metric> {
    let Some(first) = reps.first() else {
        return Vec::new();
    };
    let mut out = first.clone();
    for rep in reps.iter().skip(1) {
        let by_id: BTreeMap<&str, &Metric> = rep
            .iter()
            .map(|metric| (metric.id.as_str(), metric))
            .collect();
        for metric in &mut out {
            let Some(candidate) = by_id.get(metric.id.as_str()) else {
                continue;
            };
            let prefer_higher = metric.class.higher_is_better() || metric.class.reduces_to_worst();
            if prefer_higher == (candidate.value > metric.value) {
                metric.value = candidate.value;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{reduce, value_of, Options, SCENARIOS};
    use pragma_bench::report::{Metric, MetricClass};

    fn metric(id: &str, value: f64, class: MetricClass) -> Metric {
        Metric {
            id: id.to_string(),
            value,
            unit: "ms".to_string(),
            class,
            description: String::new(),
        }
    }

    #[test]
    fn latency_reduces_to_the_minimum() {
        let reps = vec![
            vec![metric("a", 10.0, MetricClass::Wall95)],
            vec![metric("a", 4.0, MetricClass::Wall95)],
            vec![metric("a", 7.0, MetricClass::Wall95)],
        ];
        assert!((reduce(&reps)[0].value - 4.0).abs() < f64::EPSILON);
    }

    #[test]
    fn throughput_reduces_to_the_maximum() {
        let reps = vec![
            vec![metric("a", 10.0, MetricClass::Throughput)],
            vec![metric("a", 25.0, MetricClass::Throughput)],
        ];
        assert!((reduce(&reps)[0].value - 25.0).abs() < f64::EPSILON);
    }

    #[test]
    fn counters_reduce_to_the_worst_observation() {
        // A counter that misbehaved in only one repetition must still fail the
        // audit rather than be averaged away. Coalescing metrics count frames
        // per unit of work, so "worst" is the highest for them too.
        for class in [MetricClass::Structural, MetricClass::Coalescing] {
            let reps = vec![vec![metric("a", 1.0, class)], vec![metric("a", 3.0, class)]];
            assert!(
                (reduce(&reps)[0].value - 3.0).abs() < f64::EPSILON,
                "{class:?} should keep the worst observation"
            );
        }
    }

    #[test]
    fn reduce_tolerates_a_metric_missing_from_a_repetition() {
        let reps = vec![
            vec![metric("a", 5.0, MetricClass::Wall50)],
            vec![metric("b", 1.0, MetricClass::Wall50)],
        ];
        let reduced = reduce(&reps);
        assert_eq!(reduced.len(), 1);
        assert!((reduced[0].value - 5.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_flags() {
        let args = vec!["--scale".to_string(), "quick".to_string()];
        assert_eq!(value_of(&args, "--scale"), Some("quick".to_string()));
        assert_eq!(value_of(&args, "--reps"), None);
    }

    #[test]
    fn rejects_an_unknown_scenario() {
        let args = vec![
            "--scenario".to_string(),
            "nope".to_string(),
            "--server-bin".to_string(),
            "x".to_string(),
            "--load-bin".to_string(),
            "y".to_string(),
        ];
        assert!(Options::parse(&args).is_err());
    }

    #[test]
    fn rejects_zero_repetitions() {
        let args = vec![
            "--reps".to_string(),
            "0".to_string(),
            "--server-bin".to_string(),
            "x".to_string(),
            "--load-bin".to_string(),
            "y".to_string(),
        ];
        assert!(Options::parse(&args).is_err());
    }

    #[test]
    fn every_scenario_name_is_selectable() {
        let names: Vec<&str> = SCENARIOS.to_vec();
        assert_eq!(names.len(), 4);
        for name in names {
            let args = vec![
                "--scenario".to_string(),
                name.to_string(),
                "--server-bin".to_string(),
                "x".to_string(),
                "--load-bin".to_string(),
                "y".to_string(),
            ];
            let options = Options::parse(&args).expect("scenario is selectable");
            assert!(options.wants(name));
        }
    }
}
