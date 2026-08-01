//! The `pragma-bench lines` payload: dumps the corpus into xterm's scrollback
//! and then parks.
//!
//! This is the counterpart to the TUI payload. Nothing here reads input — the
//! terminal is left in its normal screen with no mouse capture, so a wheel notch
//! is handled entirely inside xterm. That isolates renderer and scrollback cost
//! from the PTY round-trip the TUI scenario also pays.
//!
//! It parks instead of exiting because the shell would otherwise redraw a prompt
//! (and, when the session was opened for a single command, close the tab) before
//! the benchmark has scrolled anything.

use std::io::{self, BufWriter, Write};
use std::thread;

use crate::corpus;

/// Colors chosen to keep xterm's renderer honest: a scrollback of one styled
/// run per line exercises more of the attribute path than plain text does.
const MARKER_SGR: &str = "\x1b[1;33m";
const GUTTER_SGR: &str = "\x1b[90m";
const RESET_SGR: &str = "\x1b[0m";

/// Writes `lines` corpus rows to stdout, then blocks forever.
pub fn run(lines: usize) -> io::Result<()> {
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for index in 0..lines {
        let body = corpus::body(index);
        let sgr = if corpus::is_marker(index) {
            MARKER_SGR
        } else {
            ""
        };
        writeln!(
            out,
            "{GUTTER_SGR}{index:>6} │ {RESET_SGR}{sgr}{body}{RESET_SGR}"
        )?;
    }
    out.flush()?;
    park()
}

fn park() -> ! {
    // Looped because `park` may return spuriously; nothing ever unparks this
    // thread, so the process lives until the tab that owns its PTY closes.
    loop {
        thread::park();
    }
}
