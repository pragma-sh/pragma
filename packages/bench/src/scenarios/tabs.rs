//! Multi-tab scaling.
//!
//! Every open terminal costs the server a pseudoterminal, a reader thread, and a
//! coalescer thread, and every one of them competes with the tab the user is
//! actually typing into. This sweep asks the only question that matters: does
//! the foreground tab get slower as the others multiply?
//!
//! The headline result is deliberately a **ratio** — the foreground tab's
//! latency at the highest tab count divided by its latency alone. A ratio
//! cancels out machine speed, so it means the same thing on a fast laptop and a
//! loaded CI runner, and can be gated tightly where an absolute millisecond
//! figure could not be.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use crate::harness::{BenchResult, BenchServer, BenchSession};
use crate::report::MetricClass;
use crate::scenarios::{Config, Measured, ROUND_TRIP_TIMEOUT};
use crate::stats::{summarize, Summary};

const KEYS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// Sweeps tab counts and reports how the foreground tab degrades.
pub fn run(server: &BenchServer, config: &Config) -> BenchResult<Measured> {
    let mut measured = Measured::default();
    let mut summaries: Vec<(usize, Summary)> = Vec::new();

    for level in config.tab_levels() {
        let outcome = measure_level(server, config, level)?;
        measured.push(
            &format!("tabs.n{level}.spawn"),
            outcome.spawn_ms,
            "ms",
            MetricClass::Wall50,
            "Time to open one more terminal at this tab count. Regressing this is felt \
             as a slow new-tab.",
        );
        measured.push_latency(
            &format!("tabs.n{level}.echo"),
            outcome.latencies.clone(),
            outcome.summary,
            "Keystroke round trip in the foreground tab while this many tabs are open.",
        );
        measured.push(
            &format!("tabs.n{level}.replay_resets"),
            f64::from(outcome.resets),
            "count",
            MetricClass::Structural,
            "Times the server told a client its retained scrollback could not cover the \
             gap. Anything above zero is output that was dropped under load — visible as \
             a tab that silently loses part of its history.",
        );
        summaries.push((level, outcome.summary));
    }

    if let (Some((low, base)), Some((high, loaded))) = (summaries.first(), summaries.last()) {
        let ratio = if base.p95 > 0.0 {
            loaded.p95 / base.p95
        } else {
            0.0
        };
        measured.push(
            &format!("tabs.scaling.p95_ratio_{high}_over_{low}"),
            ratio,
            "ratio",
            MetricClass::Ratio,
            "Foreground keystroke latency with many tabs open, divided by the same \
             measurement with one. The primary multi-tab gate: machine speed cancels \
             out, so a rise is a real scaling regression.",
        );
    }

    Ok(measured)
}

struct LevelOutcome {
    spawn_ms: f64,
    latencies: Vec<f64>,
    summary: Summary,
    resets: u32,
}

/// Measures the foreground tab with `level` total tabs open.
fn measure_level(server: &BenchServer, config: &Config, level: usize) -> BenchResult<LevelOutcome> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut background_ids = Vec::new();
    let mut drains: Vec<JoinHandle<u64>> = Vec::new();

    // Background tabs run `noise`, which writes continuously: what degrades a
    // foreground tab is sustained competition, not a burst that finishes before
    // the measurement starts. They are drained on their own threads because the
    // server drops output to a subscriber whose channel is full, which would
    // both relieve the load and hide the loss.
    for _ in 1..level {
        let session = BenchSession::start(server, &config.payload("noise"), 200, 50)?;
        background_ids.push(session.id().to_string());
        drains.push(session.drain_in_background(&stop));
    }

    let started = Instant::now();
    let mut foreground = BenchSession::start(server, &config.payload("echo"), 80, 24)?;
    let spawn_ms = started.elapsed().as_secs_f64() * 1000.0;

    for index in 0..config.warmup_keystrokes() {
        round_trip(&mut foreground, KEYS[index % KEYS.len()])?;
    }
    let count = config.tab_keystrokes();
    let mut latencies = Vec::with_capacity(count);
    for index in 0..count {
        std::thread::sleep(config.paced_gap());
        latencies.push(round_trip(&mut foreground, KEYS[index % KEYS.len()])?);
    }

    foreground.kill()?;
    stop.store(true, Ordering::Relaxed);
    for id in background_ids {
        // Killing the session is what unblocks each drain thread's read.
        let _ = server.client().kill(id);
    }
    let resets: u64 = drains
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .sum();

    let summary = summarize(&latencies);
    Ok(LevelOutcome {
        spawn_ms,
        latencies,
        summary,
        resets: u32::try_from(resets).unwrap_or(u32::MAX),
    })
}

fn round_trip(session: &mut BenchSession, key: u8) -> BenchResult<f64> {
    let started = Instant::now();
    session.send(&[key])?;
    session.read_until(&[key], ROUND_TRIP_TIMEOUT)?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use crate::scenarios::{Config, Scale};
    use std::path::PathBuf;

    #[test]
    fn the_sweep_has_a_baseline_to_divide_by() {
        // The headline ratio is meaningless unless the sweep starts at one tab.
        for scale in [Scale::Quick, Scale::Full] {
            let config = Config {
                load_bin: PathBuf::from("pragma-bench-load"),
                scale,
            };
            assert_eq!(config.tab_levels().first(), Some(&1));
            assert!(config.tab_levels().len() >= 2);
        }
    }
}
