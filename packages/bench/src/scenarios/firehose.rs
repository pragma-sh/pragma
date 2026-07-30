//! Output throughput — how fast a lot of text gets from a program to the client.
//!
//! This is the "a TUI just repainted everything" case. Two things are measured
//! and they fail independently: how long the bytes take, and how many frames the
//! server split them into. Frame count matters on its own because every frame
//! costs a socket round trip, a channel send, and eventually an `xterm.write` —
//! so a coalescing regression is expensive long before it is slow enough to show
//! up in a wall-clock number.

use std::time::Instant;

use crate::corpus::CorpusKind;
use crate::harness::{BenchResult, BenchServer, BenchSession};
use crate::report::MetricClass;
use crate::scenarios::{Config, Measured, BULK_TIMEOUT};

/// Corpora streamed through the PTY.
///
/// A subset of the full corpus set: the parser-cost differences between kinds
/// are what the TypeScript tier measures cheaply and precisely, while this tier
/// is dominated by transport and would spend minutes to say the same thing.
/// Plain text and escape-dense text are kept because they bracket the range.
const KINDS: [CorpusKind; 2] = [CorpusKind::Ascii, CorpusKind::Sgr];

/// Streams each corpus through a real PTY and times it.
pub fn run(server: &BenchServer, config: &Config) -> BenchResult<Measured> {
    let mut measured = Measured::default();
    let bytes = config.firehose_bytes();
    for kind in KINDS {
        let payload = config.payload(&format!("firehose --kind {} --bytes {bytes}", kind.name()));
        let mut session = BenchSession::start(server, &payload, 200, 50)?;

        // The payload waits for a byte before producing anything, so the clock
        // starts immediately before the first byte exists rather than after an
        // unknown amount of it is already in flight.
        let started = Instant::now();
        session.send(b"g")?;
        let (frames, received) = session.read_bytes(bytes, BULK_TIMEOUT)?;
        let elapsed = started.elapsed().as_secs_f64().max(f64::MIN_POSITIVE);

        #[allow(
            clippy::cast_precision_loss,
            reason = "byte and frame counts here are far inside f64's exact integer range"
        )]
        let throughput = received as f64 / elapsed / (1024.0 * 1024.0);
        measured.push(
            &format!("firehose.{}.throughput", kind.name()),
            throughput,
            "MB/s",
            MetricClass::Throughput,
            "End-to-end delivery rate from a program's stdout to the client. Regressing \
             this is felt as a slow, visibly-painting build log.",
        );
        #[allow(
            clippy::cast_precision_loss,
            reason = "byte and frame counts here are far inside f64's exact integer range"
        )]
        let frames_per_mb = frames as f64 / (received as f64 / (1024.0 * 1024.0)).max(f64::EPSILON);
        measured.push(
            &format!("firehose.{}.frames_per_mb", kind.name()),
            frames_per_mb,
            "count",
            MetricClass::Coalescing,
            "Output frames the server emitted per megabyte. A rise means coalescing \
             weakened, and every extra frame is paid again at the socket, the channel, \
             and the renderer.",
        );
        measured.push(
            &format!("firehose.{}.elapsed", kind.name()),
            elapsed * 1000.0,
            "ms",
            MetricClass::Wall50,
            "Wall time to deliver the whole corpus.",
        );

        session.kill()?;
    }
    Ok(measured)
}

#[cfg(test)]
mod tests {
    use super::KINDS;
    use crate::corpus::CorpusKind;

    #[test]
    fn brackets_the_parser_cost_range() {
        // Plain text is the cheapest path and escape-dense text the most
        // expensive; measuring only one of them would hide a regression in the
        // other.
        assert!(KINDS.contains(&CorpusKind::Ascii));
        assert!(KINDS.contains(&CorpusKind::Sgr));
    }
}
