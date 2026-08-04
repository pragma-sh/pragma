//! Summary statistics for a scenario's samples.
//!
//! Percentiles, not averages: terminal lag is something a user notices in the
//! tail. A mean hides the one keystroke in twenty that took 200ms, which is
//! precisely the one they felt.

use serde::Serialize;

/// One scenario's latency distribution, in milliseconds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: usize,
    pub dropped: usize,
    pub min_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
}

impl Summary {
    /// Summarizes `samples`; an empty run yields all-zero fields with its
    /// `dropped` count intact, so a scenario that measured nothing is visible
    /// in the report rather than missing from it.
    #[must_use]
    pub fn new(samples: &[f64], dropped: usize) -> Self {
        if samples.is_empty() {
            return Self {
                count: 0,
                dropped,
                min_ms: 0.0,
                p50_ms: 0.0,
                p95_ms: 0.0,
                p99_ms: 0.0,
                max_ms: 0.0,
                mean_ms: 0.0,
            };
        }
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        let sum: f64 = sorted.iter().sum();
        Self {
            count: sorted.len(),
            dropped,
            min_ms: round(sorted[0]),
            p50_ms: round(percentile(&sorted, 50.0)),
            p95_ms: round(percentile(&sorted, 95.0)),
            p99_ms: round(percentile(&sorted, 99.0)),
            max_ms: round(sorted[sorted.len() - 1]),
            #[allow(clippy::cast_precision_loss)]
            mean_ms: round(sum / sorted.len() as f64),
        }
    }
}

/// Nearest-rank percentile over an ascending slice.
///
/// Nearest-rank rather than interpolated: every reported number is then a
/// latency that actually occurred, which matters when a reader wants to go find
/// the frame that produced it.
fn percentile(sorted: &[f64], percent: f64) -> f64 {
    debug_assert!(!sorted.is_empty());
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    let rank = ((percent / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    // Exact comparisons are correct here: every expected value is either an
    // input sample copied through unchanged or a mean of integers that is
    // representable exactly, so there is no accumulated error to tolerate.
    #![allow(clippy::float_cmp)]

    use super::*;

    #[test]
    fn percentiles_are_observed_values() {
        let samples: Vec<f64> = (1..=100).map(f64::from).collect();
        let summary = Summary::new(&samples, 0);
        assert_eq!(summary.p50_ms, 50.0);
        assert_eq!(summary.p95_ms, 95.0);
        assert_eq!(summary.p99_ms, 99.0);
        assert_eq!(summary.max_ms, 100.0);
        assert_eq!(summary.min_ms, 1.0);
        assert_eq!(summary.mean_ms, 50.5);
    }

    #[test]
    fn unsorted_input_is_sorted_first() {
        let summary = Summary::new(&[9.0, 1.0, 5.0], 0);
        assert_eq!(summary.min_ms, 1.0);
        assert_eq!(summary.max_ms, 9.0);
    }

    #[test]
    fn a_scenario_that_measured_nothing_still_reports_its_drops() {
        let summary = Summary::new(&[], 7);
        assert_eq!(summary.count, 0);
        assert_eq!(summary.dropped, 7);
        assert_eq!(summary.p95_ms, 0.0);
    }

    #[test]
    fn a_single_sample_is_every_percentile() {
        let summary = Summary::new(&[12.5], 0);
        assert_eq!(summary.p50_ms, 12.5);
        assert_eq!(summary.p99_ms, 12.5);
    }
}
