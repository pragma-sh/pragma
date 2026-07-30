//! Summary statistics over a set of observations.

/// Percentiles and extremes of one measured quantity, in whatever unit the
/// samples were collected in.
#[derive(Clone, Copy, Debug, Default)]
pub struct Summary {
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
    pub count: usize,
}

/// Summarises `samples`, which may be in any order.
///
/// Returns a zeroed summary for an empty slice rather than panicking: a
/// scenario that legitimately produced no observations (a TUI that emitted no
/// redraw at a scroll boundary, say) should report zeros and let the audit's
/// structural counters catch it, not abort the whole run.
#[must_use]
pub fn summarize(samples: &[f64]) -> Summary {
    if samples.is_empty() {
        return Summary::default();
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let sum: f64 = sorted.iter().sum();
    Summary {
        p50: percentile(&sorted, 0.50),
        p95: percentile(&sorted, 0.95),
        p99: percentile(&sorted, 0.99),
        max: *sorted.last().unwrap_or(&0.0),
        #[allow(
            clippy::cast_precision_loss,
            reason = "sample counts are thousands, far inside f64's exact integer range"
        )]
        mean: sum / sorted.len() as f64,
        count: sorted.len(),
    }
}

/// Nearest-rank percentile over an already-sorted slice.
///
/// Nearest-rank rather than interpolated so a reported p99 is always a value
/// that was actually observed — an interpolated tail invents a number between
/// two samples, which is misleading when the tail is what you are chasing.
#[must_use]
fn percentile(sorted: &[f64], quantile: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    #[allow(
        clippy::cast_precision_loss,
        reason = "sample counts are thousands, far inside f64's exact integer range"
    )]
    let rank = (quantile * sorted.len() as f64).ceil();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "rank is a ceil() of a non-negative product bounded by len()"
    )]
    let index = (rank as usize).saturating_sub(1).min(sorted.len() - 1);
    sorted[index]
}

#[cfg(test)]
mod tests {
    use super::summarize;

    #[test]
    fn summarizes_a_known_distribution() {
        let samples: Vec<f64> = (1..=100).map(f64::from).collect();
        let summary = summarize(&samples);
        assert!((summary.p50 - 50.0).abs() < f64::EPSILON);
        assert!((summary.p95 - 95.0).abs() < f64::EPSILON);
        assert!((summary.p99 - 99.0).abs() < f64::EPSILON);
        assert!((summary.max - 100.0).abs() < f64::EPSILON);
        assert!((summary.mean - 50.5).abs() < 1e-9);
        assert_eq!(summary.count, 100);
    }

    #[test]
    fn tolerates_no_observations() {
        let summary = summarize(&[]);
        assert_eq!(summary.count, 0);
        assert!((summary.p95 - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn percentiles_report_an_observed_value() {
        // Nearest-rank must never invent a value between two samples.
        let samples = vec![1.0, 1.0, 1.0, 100.0];
        let summary = summarize(&samples);
        assert!(
            (summary.p95 - 100.0).abs() < f64::EPSILON,
            "p95 should be an observed sample, got {}",
            summary.p95
        );
    }
}
