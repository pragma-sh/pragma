//! Run output: an aligned console table for the person watching, and a JSON
//! file for anything that wants to compare two runs.
//!
//! No pass/fail threshold is applied. These numbers move with machine, display
//! refresh rate, and what else is running; a gate that fired on that would be
//! noise, and the interesting comparison is always "this branch against that
//! one, on this machine, right now".

use std::fmt::Write as _;
use std::path::Path;

use serde::Serialize;

use crate::error::BenchResult;
use crate::scenarios::ScenarioRun;
use crate::stats::Summary;

/// A whole run, as written to `bench-report.json`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub generated_at: String,
    pub platform: String,
    pub channel: String,
    /// Terminal tabs open while the scenarios ran, measured tab included. Part
    /// of the report because it changes every number in it: two runs are only
    /// comparable at the same load.
    pub tabs: usize,
    pub scenarios: Vec<ScenarioReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioReport {
    pub name: String,
    pub path: String,
    pub sent: usize,
    /// True when the window lost focus during the scenario, which invalidates
    /// its numbers: an unpainted terminal produces timeouts, not latencies.
    pub unfocused: bool,
    #[serde(flatten)]
    pub summary: Summary,
    /// Every sample, so a run can be re-analysed without being re-run.
    pub samples_ms: Vec<f64>,
}

impl Report {
    #[must_use]
    pub fn new(channel: String, tabs: usize, runs: Vec<ScenarioRun>) -> Self {
        Self {
            generated_at: chrono::Local::now().to_rfc3339(),
            platform: std::env::consts::OS.to_string(),
            channel,
            tabs,
            scenarios: runs
                .into_iter()
                .map(|run| ScenarioReport {
                    name: run.scenario.to_string(),
                    path: run.scenario.description().to_string(),
                    sent: run.sent,
                    unfocused: run.unfocused,
                    summary: run.summary,
                    samples_ms: run.samples,
                })
                .collect(),
        }
    }

    /// Writes the report and prints the same numbers as a table.
    pub fn emit(&self, path: &Path) -> BenchResult<()> {
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        println!("\n{}", self.table());
        println!("report written to {}", path.display());
        Ok(())
    }

    fn table(&self) -> String {
        let mut out = String::new();
        // Writing into a String is infallible, so the results are discarded
        // rather than propagated as an error that can never happen.
        //
        // The tab count leads because it is the one setting that silently
        // rewrites every row: a p95 from an idle window and a p95 from a
        // ten-tab window are different measurements, not a regression.
        let _ = writeln!(
            out,
            "{} tab(s) open, 1 measured{}\n",
            self.tabs,
            if self.tabs > 1 {
                " — the rest running the TUI payload under it"
            } else {
                ""
            }
        );
        let _ = writeln!(
            out,
            "{:<14} {:>5} {:>7} {:>8} {:>8} {:>8} {:>8} {:>8}  path",
            "scenario", "n", "drop", "p50", "p95", "p99", "max", "mean"
        );
        for scenario in &self.scenarios {
            let summary = &scenario.summary;
            let _ = writeln!(
                out,
                "{:<14} {:>5} {:>7} {:>7.1}m {:>7.1}m {:>7.1}m {:>7.1}m {:>7.1}m  {}",
                scenario.name,
                summary.count,
                summary.dropped,
                summary.p50_ms,
                summary.p95_ms,
                summary.p99_ms,
                summary.max_ms,
                summary.mean_ms,
                scenario.path
            );
            if scenario.unfocused {
                let _ = writeln!(
                    out,
                    "{:<14} window lost focus during this scenario — its numbers are not a measurement",
                    ""
                );
            }
            // A scenario in which *nothing* reached the screen is never a slow
            // terminal — it is one of the setup failures in AGENTS.md, and it
            // otherwise prints as a row of zeroes that looks like a fast run.
            if summary.count == 0 && summary.dropped > 0 {
                let _ = writeln!(
                    out,
                    "{:<14} nothing reached the screen — a setup failure, not a latency measurement (see packages/bench/AGENTS.md)",
                    ""
                );
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenarios::Scenario;

    fn run() -> ScenarioRun {
        let samples = vec![1.0, 2.0, 3.0];
        ScenarioRun {
            scenario: Scenario::Typing,
            summary: Summary::new(&samples, 1),
            samples,
            sent: 4,
            unfocused: false,
        }
    }

    #[test]
    fn the_table_names_every_scenario_it_reports() {
        let report = Report::new("pragma-dev-test".to_string(), 10, vec![run()]);
        let table = report.table();
        assert!(table.contains("typing"), "got {table}");
        assert!(table.contains("p95"), "got {table}");
    }

    #[test]
    fn a_scenario_that_measured_nothing_says_so_instead_of_printing_zeroes() {
        let empty = ScenarioRun {
            scenario: Scenario::ScrollBuffer,
            summary: Summary::new(&[], 60),
            samples: Vec::new(),
            sent: 60,
            unfocused: false,
        };
        let table = Report::new("pragma-dev-test".to_string(), 10, vec![empty]).table();
        assert!(table.contains("nothing reached the screen"), "got {table}");
    }

    #[test]
    fn the_load_the_run_was_measured_under_is_reported_with_it() {
        let loaded = Report::new("pragma-dev-test".to_string(), 10, vec![run()]);
        assert!(loaded.table().contains("10 tab(s) open, 1 measured"));
        let idle = Report::new("pragma-dev-test".to_string(), 1, vec![run()]);
        assert!(idle.table().contains("1 tab(s) open, 1 measured"));
        assert!(!idle.table().contains("the rest running"));
        assert_eq!(
            serde_json::to_value(&loaded).expect("report serializes")["tabs"],
            10
        );
    }

    #[test]
    fn json_flattens_the_summary_next_to_the_samples() {
        let report = Report::new("pragma-dev-test".to_string(), 10, vec![run()]);
        let value = serde_json::to_value(&report).expect("report serializes");
        let scenario = &value["scenarios"][0];
        assert_eq!(scenario["p50Ms"], 2.0);
        assert_eq!(scenario["dropped"], 1);
        assert_eq!(scenario["samplesMs"].as_array().map(Vec::len), Some(3));
    }
}
