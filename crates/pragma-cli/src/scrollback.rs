//! Scrollback assembly + slicing for `tab read`.
//!
//! The server's scrollback is a capped raw frame buffer of terminal output
//! (see `SCROLLBACK_LIMIT` in `pragma-server`); it is **not** full history and
//! not line-addressed. The CLI assembles the bytes the server still holds, then
//! applies `--lines`/`--offset`/`--bytes`/`--plain`/`--raw` over that window.

use std::io::Write;

use pragma_platform::ipc::LocalStream;

use crate::server::CliError;

/// Output mode: `--plain` strips ANSI/OSC escapes (default), `--raw` emits
/// bytes verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Plain,
    Raw,
}

/// Accumulates raw scrollback bytes, then slices/skips and writes the window.
pub struct Accumulator {
    mode: Mode,
    lines: usize,
    offset: usize,
    bytes: Option<usize>,
    buf: Vec<u8>,
}

impl Accumulator {
    pub fn new(mode: Mode, lines: usize, offset: usize, bytes: Option<usize>) -> Self {
        Self {
            mode,
            lines,
            offset,
            bytes,
            buf: Vec::new(),
        }
    }

    pub fn push_output(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Writes the chosen window to `writer`. Under `--raw` the bytes are emitted
    /// verbatim; under `--plain`, ANSI escapes and OSC sequences are stripped.
    pub fn flush<W: Write>(self, mut writer: W) -> Result<(), CliError> {
        let window = self.finish_bytes();
        writer
            .write_all(&window)
            .map_err(|e| CliError::other(format!("write scrollback: {e}")))?;
        Ok(())
    }

    /// Returns the selected byte window without writing it.
    pub fn finish_bytes(self) -> Vec<u8> {
        let bytes = match self.mode {
            Mode::Raw => self.buf,
            Mode::Plain => pragma_protocol::scrollback::strip_ansi(&self.buf),
        };
        pragma_protocol::scrollback::window(&bytes, self.lines, self.offset, self.bytes)
    }
}

/// A trivial `--watch` streaming helper: reads output frames from the attached
/// session and writes them live. Honors Ctrl-C by returning on the next read
/// error or EOF; install a SIGINT handler before calling.
pub struct Watcher {
    watch: bool,
}

impl Watcher {
    pub fn new(watch: bool) -> Self {
        Self { watch }
    }

    pub fn stream(self, stream: &mut LocalStream) -> Result<(), CliError> {
        if !self.watch {
            return Ok(());
        }
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        loop {
            match read_frame_for_watch(stream) {
                Ok(Frame::Output { data, .. }) => {
                    let _ = out.write_all(&data);
                    let _ = out.flush();
                }
                // The server never sends an `Input` frame back to a client.
                Ok(Frame::Input { .. }) => {}
                Ok(Frame::Json(bytes)) => {
                    if let Ok(ServerFrame::Event(EventFrame::Exit { .. })) =
                        serde_json::from_slice::<ServerFrame>(&bytes)
                    {
                        return Ok(());
                    }
                }
                Err(_) => return Ok(()),
            }
        }
    }
}

fn read_frame_for_watch(stream: &mut LocalStream) -> Result<Frame, CliError> {
    pragma_protocol::read_frame(stream).map_err(CliError::from)
}

use pragma_protocol::{EventFrame, Frame, ServerFrame};
