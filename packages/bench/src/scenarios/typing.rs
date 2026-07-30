//! Keystroke round-trip latency.
//!
//! Measures hops 4-7: `PragmaClient`'s queued writer → local socket →
//! `pragma-server` → PTY → the reader thread → the output coalescer → back over
//! the socket. This is the scenario that answers "does typing feel laggy", and
//! its floor is not zero: the server coalesces output on an 8 ms interval, so a
//! healthy round trip still costs several milliseconds.

use std::thread;
use std::time::Instant;

use crate::harness::{BenchResult, BenchServer, BenchSession};
use crate::report::MetricClass;
use crate::scenarios::{typing_text, Config, Measured, BULK_TIMEOUT, ROUND_TRIP_TIMEOUT};
use crate::stats::summarize;

/// Distinct bytes cycled through as keystrokes.
///
/// Each round trip waits for the exact byte it sent, so consecutive keystrokes
/// use different bytes: repeating one byte would let a stale echo satisfy the
/// next wait and report a latency of nearly zero.
const KEYS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// Runs the paced and burst typing cases.
pub fn run(server: &BenchServer, config: &Config) -> BenchResult<Measured> {
    let mut session = BenchSession::start(server, &config.payload("echo"), 80, 24)?;
    let mut measured = Measured::default();

    for index in 0..config.warmup_keystrokes() {
        round_trip(&mut session, key_at(index))?;
    }

    let count = config.paced_keystrokes();
    let mut latencies = Vec::with_capacity(count);
    let mut frames = 0_usize;
    for index in 0..count {
        thread::sleep(config.paced_gap());
        let (elapsed_ms, observed) = round_trip(&mut session, key_at(index))?;
        latencies.push(elapsed_ms);
        frames += observed;
    }
    let summary = summarize(&latencies);
    measured.push_latency(
        "typing.paced.echo",
        latencies,
        summary,
        "Round trip from a keystroke leaving the client to its echo arriving back. \
         Regressing this is felt directly as typing lag.",
    );
    #[allow(
        clippy::cast_precision_loss,
        reason = "keystroke counts are hundreds, exact in f64"
    )]
    let frames_per_keystroke = frames as f64 / count as f64;
    measured.push(
        "typing.paced.frames_per_keystroke",
        frames_per_keystroke,
        "count",
        MetricClass::Structural,
        "Output frames delivered per keystroke. One echoed byte should cost exactly one \
         frame; more means the server stopped coalescing, fewer means echoes are being \
         batched and latency has been traded away.",
    );

    // The burst case is the thousand-word paste: no cadence, so it is bounded by
    // how fast the pipeline drains rather than by how fast anyone can type.
    let text = typing_text(config.burst_words());
    let started = Instant::now();
    session.send(&text)?;
    let (burst_frames, burst_bytes) = session.read_bytes(text.len(), BULK_TIMEOUT)?;
    let burst_ms = elapsed_ms(started);
    measured.push(
        "typing.burst.drain",
        burst_ms,
        "ms",
        MetricClass::Wall50,
        "Time to echo a pasted thousand-word block. Regressing this is felt as a freeze \
         after a paste.",
    );
    // Expressed as frames per kilobyte rather than the more natural-sounding
    // bytes per frame, so that a *rise* is the regression. The worst-case
    // reduction across repetitions keeps the highest value, which would keep the
    // best observation instead of the worst if the metric were inverted.
    #[allow(
        clippy::cast_precision_loss,
        reason = "byte and frame counts here are far inside f64's exact integer range"
    )]
    let frames_per_kb = burst_frames as f64 / (burst_bytes as f64 / 1024.0).max(f64::EPSILON);
    measured.push(
        "typing.burst.frames_per_kb",
        frames_per_kb,
        "count",
        MetricClass::Coalescing,
        "Output frames the server emitted per kilobyte of a paste. A rise means the \
         coalescer is emitting more, smaller frames, which multiplies per-frame cost all \
         the way to the renderer.",
    );

    session.kill()?;
    Ok(measured)
}

/// Sends one keystroke and waits for its echo, returning `(ms, frames)`.
fn round_trip(session: &mut BenchSession, key: u8) -> BenchResult<(f64, usize)> {
    let started = Instant::now();
    session.send(&[key])?;
    let frames = session.read_until(&[key], ROUND_TRIP_TIMEOUT)?;
    Ok((elapsed_ms(started), frames))
}

fn key_at(index: usize) -> u8 {
    KEYS[index % KEYS.len()]
}

/// Milliseconds since `started`, as a float.
fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::{key_at, KEYS};

    #[test]
    fn consecutive_keystrokes_use_different_bytes() {
        // If this ever stopped holding, a stale echo could satisfy the next
        // wait and every latency would be reported as near zero.
        for index in 0..KEYS.len() * 3 {
            assert_ne!(key_at(index), key_at(index + 1), "at index {index}");
        }
    }

    #[test]
    fn keys_cycle() {
        assert_eq!(key_at(0), key_at(KEYS.len()));
    }
}
