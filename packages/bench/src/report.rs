//! The report shape every benchmark tier emits, and the machine-speed
//! calibration that makes recorded baselines survive a runner upgrade.

use std::collections::BTreeMap;
use std::hint::black_box;
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// How noisy a metric is, which is what decides the margin the audit allows.
///
/// Splitting metrics this way is the whole reason a committed baseline can be
/// gated tightly: a counter that cannot vary with machine speed gets an exact
/// match, while a p99 — which is one sample, and one scheduler preemption owns
/// it — gets a wide band. A single blanket margin would have to be as loose as
/// the worst metric, which would let real regressions through everywhere else.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricClass {
    /// A count that does not depend on machine speed (frames per keystroke,
    /// evictions, dropped events). Any change at all is a regression.
    Structural,
    /// Frames the server emitted per unit of transferred work.
    ///
    /// Deliberately *not* [`Structural`](Self::Structural), tempting as that
    /// looks. Frame density during a bulk transfer is a product of the server's
    /// 8 ms coalescing window racing however fast the bytes actually arrive, so
    /// it drifts with machine speed and load even when nothing regressed.
    /// Gating it exactly would flake; leaving it ungated would miss the
    /// coalescing regressions it exists to catch, which are expensive long
    /// before they are slow enough to move a wall-clock number.
    ///
    /// Every metric in this class counts frames per unit of work, so a *rise* is
    /// always the regression — never invert one of these into "bytes per frame",
    /// or the worst-case reduction would silently keep the best observation.
    Coalescing,
    /// A dimensionless ratio between two measurements from the same run, so
    /// machine speed cancels out.
    Ratio,
    /// Bytes per second. Calibrated.
    Throughput,
    /// Median wall time. Calibrated.
    Wall50,
    /// 95th-percentile wall time. Calibrated.
    Wall95,
    /// 99th-percentile or maximum wall time. Calibrated.
    Wall99,
}

impl MetricClass {
    /// Whether the audit divides this metric by the calibration scalar before
    /// comparing it to the baseline.
    #[must_use]
    pub fn is_calibrated(self) -> bool {
        matches!(
            self,
            Self::Throughput | Self::Wall50 | Self::Wall95 | Self::Wall99
        )
    }

    /// Whether a *larger* value is an improvement (throughput) rather than a
    /// regression (latency). The audit needs this to know which direction of
    /// drift to fail on.
    #[must_use]
    pub fn higher_is_better(self) -> bool {
        matches!(self, Self::Throughput)
    }

    /// Whether repetitions reduce to the *worst* observation instead of the best.
    ///
    /// Wall time and throughput reduce to the best a machine managed, because
    /// their noise is one-sided and the best run is the closest estimate of the
    /// true cost. Counters are different: they are supposed to be identical
    /// every repetition, so a repetition that disagreed found something real and
    /// must not be averaged or minimised away.
    #[must_use]
    pub fn reduces_to_worst(self) -> bool {
        matches!(self, Self::Structural | Self::Coalescing)
    }
}

/// One measured value.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// Dotted, stable identifier — `typing.paced.echo.p95`. Renaming one orphans
    /// its baseline entry, which the audit reports as a new metric rather than
    /// silently passing.
    pub id: String,
    pub value: f64,
    /// Display unit: `ms`, `MB/s`, `count`, or `ratio`.
    pub unit: String,
    pub class: MetricClass,
    /// One line explaining what regressing this metric would mean for a user.
    pub description: String,
}

/// The environment a report was produced on. Baselines are keyed by this, since
/// a macOS arm64 number says nothing about a Linux x64 runner.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub os: String,
    pub arch: String,
}

impl Platform {
    /// Detects the current platform.
    #[must_use]
    pub fn detect() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

/// One tier's results.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `t1`, `t2`, or `t3`.
    pub tier: String,
    pub platform: Platform,
    /// Nanoseconds the calibration probe took on this machine. Calibrated
    /// metrics are compared as `value / calibrationNs`, so a faster or slower
    /// runner moves both the probe and the measurement together and the
    /// comparison stays valid.
    pub calibration_ns: u64,
    pub metrics: Vec<Metric>,
    /// Every individual observation, keyed by metric prefix. Never gated — this
    /// is what lets a histogram be re-derived later without re-running.
    pub samples: BTreeMap<String, Vec<f64>>,
}

/// Iterations of the calibration probe. Sized to run for roughly 30-60 ms on a
/// current laptop: long enough to average over scheduler noise, short enough
/// that seven repetitions cost well under a second.
const CALIBRATION_ITERATIONS: u64 = 20_000_000;

/// Measures this machine's speed with a fixed, allocation-free integer loop.
///
/// Deliberately not a timer resolution probe and not anything I/O bound: it has
/// to be pure CPU work whose cost is stable within a machine and proportional
/// between machines, so dividing a wall-time metric by it cancels out hardware
/// differences.
#[must_use]
pub fn calibrate() -> u64 {
    let started = Instant::now();
    let mut state: u64 = 0x243F_6A88_85A3_08D3;
    for _ in 0..CALIBRATION_ITERATIONS {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        state ^= state >> 33;
        black_box(state);
    }
    black_box(state);
    let elapsed = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
    // Never return zero: the audit divides by this.
    elapsed.max(1)
}

#[cfg(test)]
mod tests {
    use super::{calibrate, MetricClass, Platform};

    #[test]
    fn calibration_is_positive_and_repeatable_within_an_order_of_magnitude() {
        let first = calibrate();
        let second = calibrate();
        assert!(first > 0 && second > 0);
        let (low, high) = if first < second {
            (first, second)
        } else {
            (second, first)
        };
        // A probe whose own spread exceeds 10x would make every calibrated
        // comparison meaningless, so assert the property the audit relies on.
        assert!(
            high < low.saturating_mul(10),
            "calibration probe is too noisy: {low} vs {high}"
        );
    }

    #[test]
    fn only_wall_and_throughput_metrics_are_calibrated() {
        assert!(!MetricClass::Structural.is_calibrated());
        assert!(!MetricClass::Coalescing.is_calibrated());
        assert!(!MetricClass::Ratio.is_calibrated());
        assert!(MetricClass::Throughput.is_calibrated());
        assert!(MetricClass::Wall95.is_calibrated());
    }

    #[test]
    fn only_throughput_improves_when_it_rises() {
        assert!(MetricClass::Throughput.higher_is_better());
        assert!(!MetricClass::Wall50.higher_is_better());
        assert!(!MetricClass::Structural.higher_is_better());
        // Every coalescing metric counts frames per unit of work, so a rise is
        // the regression. Inverting one would defeat the worst-case reduction.
        assert!(!MetricClass::Coalescing.higher_is_better());
    }

    #[test]
    fn platform_is_populated() {
        let platform = Platform::detect();
        assert!(!platform.os.is_empty());
        assert!(!platform.arch.is_empty());
    }
}
