//! `pragma-bench-load` — the deterministic payload the benchmark measures.
//!
//! Benchmarking against a real login shell would fold that shell's prompt,
//! plugins, and start-up cost into every sample, and those differ per machine
//! and per developer. This program is `exec`'d in place of the shell so what is
//! on the far end of the pseudoterminal is identical everywhere.
//!
//! Modes:
//! - `echo` — writes back exactly what it reads. Keystroke round-trip.
//! - `firehose` — dumps a corpus once triggered. Output throughput.
//! - `tui` — takes the alternate screen with mouse tracking and repaints the
//!   whole grid per wheel report. TUI scroll round-trip.
//! - `corpus` — dumps a corpus to stdout for the TypeScript parser tier, so
//!   both tiers measure byte-identical input.

use std::fmt::Write as _;
use std::io::Read;
use std::process::ExitCode;

use pragma_bench::corpus::{self, CorpusKind};
use pragma_bench::harness::{write_now, FRAME_MARKER, READY_MARKER};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pragma-bench-load: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map_or("", String::as_str);
    match mode {
        "echo" => echo(),
        "firehose" => firehose(&args),
        "noise" => noise(&args),
        "tui" => tui(&args),
        "corpus" => dump_corpus(&args),
        other => Err(format!(
            "unknown mode {other:?}; expected echo, firehose, noise, tui, or corpus"
        )),
    }
}

/// Reads and writes back verbatim, for as long as the benchmark keeps typing.
///
/// The session is put into raw mode before this program is `exec`'d, so no
/// kernel echo and no line buffering sit between the write and the read — the
/// measured round trip is the transport, not the terminal line discipline.
fn echo() -> Result<(), String> {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    write_now(&mut stdout, READY_MARKER).map_err(|error| error.to_string())?;
    let mut buffer = [0_u8; 4096];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => {
                let Some(chunk) = buffer.get(..read) else {
                    return Ok(());
                };
                write_now(&mut stdout, chunk).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Announces readiness, waits for a trigger byte, then writes the corpus once.
///
/// The trigger exists so the benchmark starts its clock immediately before the
/// first byte is produced; without it the corpus would already be in flight by
/// the time the measurement began.
fn firehose(args: &[String]) -> Result<(), String> {
    let kind = kind_arg(args)?;
    let bytes = usize_arg(args, "--bytes", 8 * 1024 * 1024)?;
    let payload = corpus::build(kind, bytes);
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    write_now(&mut stdout, READY_MARKER).map_err(|error| error.to_string())?;
    let mut trigger = [0_u8; 1];
    stdin.read_exact(&mut trigger).map_err(|e| e.to_string())?;
    write_now(&mut stdout, &payload).map_err(|error| error.to_string())?;
    // Hold the terminal open so the benchmark reads the payload out of the
    // stream rather than racing the session's exit event.
    let mut sink = Vec::new();
    let _ = stdin.read_to_end(&mut sink);
    Ok(())
}

/// Writes a corpus on a loop until the terminal goes away.
///
/// This is the background load in the tab-scaling scenario: what degrades a
/// foreground tab is *sustained* competition for the server's reader threads and
/// coalescer, not one burst that finishes before the measurement starts.
fn noise(args: &[String]) -> Result<(), String> {
    let kind = kind_arg(args)?;
    let payload = corpus::build(kind, usize_arg(args, "--bytes", 64 * 1024)?);
    let mut stdout = std::io::stdout().lock();
    write_now(&mut stdout, READY_MARKER).map_err(|error| error.to_string())?;
    // Exits when the write fails, which is what happens once the session is
    // killed — no separate shutdown channel needed.
    while write_now(&mut stdout, &payload).is_ok() {}
    Ok(())
}

/// A minimal full-screen application with mouse tracking.
///
/// Repaints every row on each wheel report, which is what a real TUI does and
/// what makes wheel-driven scrolling expensive: one gesture becomes one
/// full-grid redraw per report, over the pseudoterminal, each way.
fn tui(args: &[String]) -> Result<(), String> {
    let rows = u16_arg(args, "--rows", 24)?;
    let cols = u16_arg(args, "--cols", 80)?;
    let frame = grid_frame(rows, cols);
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    // Alternate screen, hide cursor, SGR mouse tracking (1006) with any-motion
    // reporting (1003) — the mode set xterm's wheel gate is written against.
    let mut enter = String::new();
    let _ = write!(enter, "\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h");
    write_now(&mut stdout, enter.as_bytes()).map_err(|error| error.to_string())?;
    write_now(&mut stdout, &frame).map_err(|error| error.to_string())?;
    write_now(&mut stdout, READY_MARKER).map_err(|error| error.to_string())?;

    let mut buffer = [0_u8; 4096];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => {
                let Some(chunk) = buffer.get(..read) else {
                    return Ok(());
                };
                // One redraw per report, not per read: a read can coalesce
                // several reports, and collapsing them here would understate
                // the redraw cost a real application pays.
                for _ in 0..count_reports(chunk) {
                    write_now(&mut stdout, &frame).map_err(|error| error.to_string())?;
                    write_now(&mut stdout, FRAME_MARKER).map_err(|error| error.to_string())?;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Writes a corpus to stdout, with no readiness marker and no terminal setup.
fn dump_corpus(args: &[String]) -> Result<(), String> {
    let kind = kind_arg(args)?;
    let bytes = usize_arg(args, "--bytes", 8 * 1024 * 1024)?;
    let payload = corpus::build(kind, bytes);
    let mut stdout = std::io::stdout().lock();
    write_now(&mut stdout, &payload).map_err(|error| error.to_string())
}

/// Cells between colour changes in a rendered frame.
const ATTRIBUTE_RUN: u16 = 8;

/// Renders one full-screen frame: every row addressed, cleared, and repainted.
fn grid_frame(rows: u16, cols: u16) -> Vec<u8> {
    let mut frame = String::new();
    for row in 1..=rows {
        let _ = write!(frame, "\x1b[{row};1H\x1b[2K");
        for col in 0..cols {
            // Change colour every eighth cell rather than every cell: real
            // applications emit runs, and a per-cell escape would inflate one
            // frame to tens of kilobytes — measuring an artefact of the payload
            // instead of the redraw path.
            if col % ATTRIBUTE_RUN == 0 {
                let shade = 16 + row.wrapping_mul(3).wrapping_add(col) % 216;
                let _ = write!(frame, "\x1b[38;5;{shade}m");
            }
            frame.push('#');
        }
        frame.push_str("\x1b[0m");
    }
    frame.into_bytes()
}

/// Counts SGR mouse reports (`ESC [ < … M/m`) in a chunk of input.
fn count_reports(chunk: &[u8]) -> usize {
    let count = chunk
        .windows(3)
        .filter(|window| *window == b"\x1b[<")
        .count();
    // Any input at all should produce at least one redraw, so a benchmark that
    // sends a plain keystroke still observes a response rather than hanging.
    count.max(1)
}

fn kind_arg(args: &[String]) -> Result<CorpusKind, String> {
    let raw = string_arg(args, "--kind").unwrap_or_else(|| "ascii".to_string());
    CorpusKind::parse(&raw).ok_or_else(|| format!("unknown corpus kind {raw:?}"))
}

fn string_arg(args: &[String], flag: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == flag)?;
    args.get(at + 1).cloned()
}

fn usize_arg(args: &[String], flag: &str, fallback: usize) -> Result<usize, String> {
    match string_arg(args, flag) {
        None => Ok(fallback),
        Some(raw) => raw
            .parse()
            .map_err(|_| format!("{flag} expects a number, got {raw:?}")),
    }
}

fn u16_arg(args: &[String], flag: &str, fallback: u16) -> Result<u16, String> {
    match string_arg(args, flag) {
        None => Ok(fallback),
        Some(raw) => raw
            .parse()
            .map_err(|_| format!("{flag} expects a number, got {raw:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{count_reports, grid_frame, string_arg, u16_arg, usize_arg};

    #[test]
    fn counts_every_report_in_a_coalesced_read() {
        let chunk = b"\x1b[<65;10;5M\x1b[<65;10;6M\x1b[<64;10;7M";
        assert_eq!(count_reports(chunk), 3);
    }

    #[test]
    fn always_responds_to_some_input() {
        // A payload that stayed silent on unrecognised input would hang the
        // benchmark rather than fail it.
        assert_eq!(count_reports(b"x"), 1);
    }

    #[test]
    fn frame_addresses_every_row() {
        let frame = String::from_utf8(grid_frame(3, 4)).expect("frame is utf-8");
        for row in 1..=3 {
            assert!(
                frame.contains(&format!("\x1b[{row};1H")),
                "row {row} missing"
            );
        }
    }

    #[test]
    fn parses_flags_and_falls_back() {
        let args = vec![
            "firehose".to_string(),
            "--bytes".to_string(),
            "1024".to_string(),
        ];
        assert_eq!(usize_arg(&args, "--bytes", 7).expect("parsed"), 1024);
        assert_eq!(usize_arg(&args, "--missing", 7).expect("fallback"), 7);
        assert_eq!(u16_arg(&args, "--rows", 24).expect("fallback"), 24);
        assert_eq!(string_arg(&args, "--bytes"), Some("1024".to_string()));
        assert!(usize_arg(&args[..2], "--bytes", 7).is_ok());
    }

    #[test]
    fn rejects_a_non_numeric_flag() {
        let args = vec!["--bytes".to_string(), "lots".to_string()];
        assert!(usize_arg(&args, "--bytes", 7).is_err());
    }
}
