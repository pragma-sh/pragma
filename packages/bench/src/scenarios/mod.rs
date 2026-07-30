//! The T1 scenarios, and the configuration they share.

pub mod firehose;
pub mod scroll;
pub mod tabs;
pub mod typing;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::report::{Metric, MetricClass};
use crate::stats::Summary;

/// One scenario's contribution to a report.
#[derive(Clone, Debug, Default)]
pub struct Measured {
    pub metrics: Vec<Metric>,
    /// Raw observations, keyed by metric prefix. Never gated — kept so a
    /// histogram can be re-derived from a stored report without re-running.
    pub samples: BTreeMap<String, Vec<f64>>,
}

impl Measured {
    /// Records a metric.
    pub fn push(&mut self, id: &str, value: f64, unit: &str, class: MetricClass, why: &str) {
        self.metrics.push(Metric {
            id: id.to_string(),
            value,
            unit: unit.to_string(),
            class,
            description: why.to_string(),
        });
    }

    /// Records the p50/p95/p99 of a latency distribution plus its raw samples.
    pub fn push_latency(&mut self, prefix: &str, samples: Vec<f64>, summary: Summary, why: &str) {
        self.push(
            &format!("{prefix}.p50"),
            summary.p50,
            "ms",
            MetricClass::Wall50,
            why,
        );
        self.push(
            &format!("{prefix}.p95"),
            summary.p95,
            "ms",
            MetricClass::Wall95,
            why,
        );
        self.push(
            &format!("{prefix}.p99"),
            summary.p99,
            "ms",
            MetricClass::Wall99,
            why,
        );
        self.samples.insert(prefix.to_string(), samples);
    }

    /// Merges another scenario's output into this one.
    pub fn absorb(&mut self, other: Self) {
        self.metrics.extend(other.metrics);
        self.samples.extend(other.samples);
    }
}

/// How much work each scenario does.
///
/// A benchmark nobody runs locally is a benchmark nobody trusts, so `Quick`
/// exists to make the whole suite finish in well under a minute while measuring
/// the same things. Baselines are recorded per scale, never shared between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scale {
    Quick,
    Full,
}

impl Scale {
    /// Parses a scale from its CLI spelling.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "quick" => Some(Self::Quick),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    /// The CLI spelling, which is also part of the baseline file's key.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Quick => "quick",
            Self::Full => "full",
        }
    }
}

/// Everything a scenario needs to run.
#[derive(Clone, Debug)]
pub struct Config {
    /// Path to the `pragma-bench-load` executable the sessions `exec`.
    pub load_bin: PathBuf,
    pub scale: Scale,
}

impl Config {
    /// Keystrokes measured in the paced typing scenario.
    ///
    /// Deliberately *not* a literal thousand words. A thousand words is roughly
    /// six thousand keystrokes, and at a realistic human gap that is ten minutes
    /// per repetition — seventy minutes across seven repetitions, which no CI
    /// job would tolerate. The paced case measures per-keystroke latency, where
    /// several hundred samples already pin every percentile the audit gates on;
    /// the full thousand words is measured instead by the burst case, which
    /// sends all of it and is bounded by throughput rather than by cadence.
    #[must_use]
    pub fn paced_keystrokes(&self) -> usize {
        match self.scale {
            Scale::Quick => 200,
            Scale::Full => 500,
        }
    }

    /// Gap between paced keystrokes. Short enough to keep the run bounded, long
    /// enough that each round trip starts from an idle pipeline rather than
    /// queueing behind its predecessor.
    ///
    /// Expect the resulting latencies to be *bimodal*, and do not read that as
    /// noise. The server flushes output at most once per 8 ms coalescing
    /// interval, so a keystroke that lands just after a flush is echoed almost
    /// immediately while one landing just before waits out the window. A 10 ms
    /// cadence beats against an 8 ms window, so samples sweep the whole range —
    /// which is exactly what a person typing experiences, and why the percentiles
    /// rather than the mean are what the audit gates on.
    #[must_use]
    pub fn paced_gap(&self) -> Duration {
        Duration::from_millis(10)
    }

    /// Keystrokes discarded before measurement, so first-touch page faults and
    /// lazily-started client threads are not charged to the first samples.
    #[must_use]
    pub fn warmup_keystrokes(&self) -> usize {
        30
    }

    /// Words in the burst ("paste a thousand words") case.
    #[must_use]
    pub fn burst_words(&self) -> usize {
        1000
    }

    /// Bytes streamed per corpus in the output-throughput scenario.
    #[must_use]
    pub fn firehose_bytes(&self) -> usize {
        match self.scale {
            Scale::Quick => 1024 * 1024,
            Scale::Full => 4 * 1024 * 1024,
        }
    }

    /// Wheel reports sent in the TUI scroll scenario.
    ///
    /// A trackpad flick covering roughly five thousand pixels lands in this
    /// range once the renderer's own pacing is applied, and the direction flips
    /// matter more than the raw count: a flip is what exercises the quiet-window
    /// logic that historically stalled scrolling.
    #[must_use]
    pub fn wheel_reports(&self) -> usize {
        match self.scale {
            Scale::Quick => 60,
            Scale::Full => 200,
        }
    }

    /// Wheel reports sent in one direction before reversing.
    #[must_use]
    pub fn wheel_run_length(&self) -> usize {
        20
    }

    /// Tab counts swept in the scaling scenario. Chosen to straddle the
    /// frontend's renderer cache size of eight, which is where the desktop app
    /// starts evicting.
    #[must_use]
    pub fn tab_levels(&self) -> Vec<usize> {
        match self.scale {
            Scale::Quick => vec![1, 8],
            Scale::Full => vec![1, 4, 8, 16],
        }
    }

    /// Keystrokes measured in the foreground tab at each tab level.
    #[must_use]
    pub fn tab_keystrokes(&self) -> usize {
        match self.scale {
            Scale::Quick => 100,
            Scale::Full => 200,
        }
    }

    /// The `pragma-bench-load` command line for a payload mode.
    #[must_use]
    pub fn payload(&self, args: &str) -> String {
        format!("{} {args}", self.load_bin.display())
    }
}

/// Words used to build typed input. Fixed so every run types the same bytes.
pub const TYPING_WORDS: &[&str] = &[
    "the",
    "quick",
    "brown",
    "terminal",
    "renders",
    "every",
    "keystroke",
    "without",
    "any",
    "perceptible",
    "latency",
    "when",
    "the",
    "pipeline",
    "is",
    "healthy",
];

/// Builds `words` words of typed text.
#[must_use]
pub fn typing_text(words: usize) -> Vec<u8> {
    let mut out = String::new();
    for index in 0..words {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(TYPING_WORDS[index % TYPING_WORDS.len()]);
    }
    out.into_bytes()
}

/// Timeout for any single round trip inside a scenario.
pub const ROUND_TRIP_TIMEOUT: Duration = Duration::from_secs(20);

/// Timeout for a bulk transfer.
pub const BULK_TIMEOUT: Duration = Duration::from_secs(90);

#[cfg(test)]
mod tests {
    use super::{typing_text, Config, Measured, Scale};
    use crate::report::MetricClass;
    use crate::stats::summarize;
    use std::path::PathBuf;

    fn config(scale: Scale) -> Config {
        Config {
            load_bin: PathBuf::from("pragma-bench-load"),
            scale,
        }
    }

    #[test]
    fn quick_scale_is_cheaper_than_full_everywhere() {
        let (quick, full) = (config(Scale::Quick), config(Scale::Full));
        assert!(quick.paced_keystrokes() < full.paced_keystrokes());
        assert!(quick.firehose_bytes() < full.firehose_bytes());
        assert!(quick.wheel_reports() < full.wheel_reports());
        assert!(quick.tab_levels().len() < full.tab_levels().len());
    }

    #[test]
    fn tab_levels_straddle_the_renderer_cache_size() {
        // The frontend evicts a WebGL renderer at eight, so a sweep that stopped
        // below it would never reach the cliff this scenario exists to find.
        let levels = config(Scale::Full).tab_levels();
        assert!(levels.contains(&8));
        assert!(levels.iter().any(|level| *level > 8));
    }

    #[test]
    fn typing_text_is_deterministic_and_sized() {
        assert_eq!(typing_text(50), typing_text(50));
        let text = typing_text(1000);
        #[allow(
            clippy::naive_bytecount,
            reason = "a test assertion, not a hot path; a bytecount dependency for this would be absurd"
        )]
        let spaces = text.iter().filter(|byte| **byte == b' ').count();
        assert_eq!(spaces, 999);
    }

    #[test]
    fn scale_round_trips_its_name() {
        for scale in [Scale::Quick, Scale::Full] {
            assert_eq!(Scale::parse(scale.name()), Some(scale));
        }
        assert_eq!(Scale::parse("medium"), None);
    }

    #[test]
    fn latency_metrics_carry_their_noise_class() {
        let mut measured = Measured::default();
        let samples = vec![1.0, 2.0, 3.0, 4.0];
        measured.push_latency("x.y", samples.clone(), summarize(&samples), "why");
        let classes: Vec<MetricClass> = measured.metrics.iter().map(|m| m.class).collect();
        assert_eq!(
            classes,
            vec![
                MetricClass::Wall50,
                MetricClass::Wall95,
                MetricClass::Wall99
            ]
        );
        assert_eq!(measured.samples.get("x.y"), Some(&samples));
    }
}
