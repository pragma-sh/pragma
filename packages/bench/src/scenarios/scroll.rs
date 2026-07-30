//! TUI scroll round-trip.
//!
//! Scrolling inside a mouse-tracking TUI is not a viewport operation — every
//! wheel report crosses the pseudoterminal, the application repaints the whole
//! grid, and the repaint crosses back. That round trip is the dominant cost of
//! scrolling in an agent's TUI, and it is fully visible from this tier.
//!
//! Direction flips are measured separately from steady scrolling because they
//! are what historically stalled: the frontend gates wheel reports on the
//! renderer draining, with a quiet window that treats a gap as a new gesture, so
//! a reversal is the case most likely to fall off the fast path.

use std::time::Instant;

use crate::harness::{BenchResult, BenchServer, BenchSession, FRAME_MARKER};
use crate::report::MetricClass;
use crate::scenarios::{Config, Measured, ROUND_TRIP_TIMEOUT};
use crate::stats::summarize;

/// SGR wheel-up report at a fixed cell.
const WHEEL_UP: &[u8] = b"\x1b[<64;10;5M";
/// SGR wheel-down report at a fixed cell.
const WHEEL_DOWN: &[u8] = b"\x1b[<65;10;5M";

const COLS: u16 = 120;
const ROWS: u16 = 40;

/// Scrolls up and down, reversing periodically, and times each redraw.
pub fn run(server: &BenchServer, config: &Config) -> BenchResult<Measured> {
    let payload = config.payload(&format!("tui --rows {ROWS} --cols {COLS}"));
    let mut session = BenchSession::start(server, &payload, COLS, ROWS)?;
    let mut measured = Measured::default();

    // Warm the path: the first redraw after taking the alternate screen is
    // atypically expensive and would otherwise land in the tail.
    for _ in 0..5 {
        report_round_trip(&mut session, WHEEL_DOWN)?;
    }

    let total = config.wheel_reports();
    let run_length = config.wheel_run_length();
    let mut steady = Vec::new();
    let mut flips = Vec::new();
    let mut frames = 0_usize;
    let mut going_down = true;
    for index in 0..total {
        let is_flip = index > 0 && index % run_length == 0;
        if is_flip {
            going_down = !going_down;
        }
        let report = if going_down { WHEEL_DOWN } else { WHEEL_UP };
        let (elapsed, observed) = report_round_trip(&mut session, report)?;
        frames += observed;
        if is_flip {
            flips.push(elapsed);
        } else {
            steady.push(elapsed);
        }
    }

    let steady_summary = summarize(&steady);
    measured.push_latency(
        "scroll.tui.steady",
        steady,
        steady_summary,
        "Time from a wheel report leaving the client to the application's repaint \
         arriving back, while scrolling in one direction.",
    );
    let flip_summary = summarize(&flips);
    measured.push_latency(
        "scroll.tui.flip",
        flips,
        flip_summary,
        "The same round trip on the report that reverses direction. This is where \
         scrolling stalls first.",
    );
    let flip_penalty = if steady_summary.p50 > 0.0 {
        flip_summary.p50 / steady_summary.p50
    } else {
        0.0
    };
    measured.push(
        "scroll.tui.flip_penalty",
        flip_penalty,
        "ratio",
        MetricClass::Ratio,
        "How much more a direction reversal costs than steady scrolling. Machine speed \
         cancels out, so this catches a pacing regression on any runner.",
    );
    #[allow(
        clippy::cast_precision_loss,
        reason = "report counts are hundreds, exact in f64"
    )]
    let frames_per_report = frames as f64 / total.max(1) as f64;
    measured.push(
        "scroll.tui.frames_per_report",
        frames_per_report,
        "count",
        MetricClass::Coalescing,
        "Output frames delivered per wheel report. A rise means one repaint is being \
         split across more frames, which is what makes a scroll look torn.",
    );

    session.kill()?;
    Ok(measured)
}

/// Sends one wheel report and waits for the repaint it triggers.
fn report_round_trip(session: &mut BenchSession, report: &[u8]) -> BenchResult<(f64, usize)> {
    let started = Instant::now();
    session.send(report)?;
    let frames = session.read_until(FRAME_MARKER, ROUND_TRIP_TIMEOUT)?;
    Ok((started.elapsed().as_secs_f64() * 1000.0, frames))
}

#[cfg(test)]
mod tests {
    use super::{WHEEL_DOWN, WHEEL_UP};

    #[test]
    fn wheel_reports_are_sgr_encoded_and_distinct() {
        // The payload counts `ESC [ <` occurrences, and the two directions must
        // differ or a "flip" would not actually reverse anything.
        assert!(WHEEL_UP.starts_with(b"\x1b[<"));
        assert!(WHEEL_DOWN.starts_with(b"\x1b[<"));
        assert_ne!(WHEEL_UP, WHEEL_DOWN);
    }
}
