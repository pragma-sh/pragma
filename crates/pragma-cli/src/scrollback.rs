//! Scrollback assembly + slicing for `tab read`.
//!
//! The server's scrollback is a capped raw frame buffer of terminal output
//! (see `SCROLLBACK_LIMIT` in `pragma-server`); it is **not** full history and
//! not line-addressed. The CLI assembles the bytes the server still holds, then
//! applies `--lines`/`--offset`/`--bytes`/`--plain`/`--raw` over that window.

use std::io::Write;

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
            Mode::Plain => strip_ansi(&self.buf),
        };
        window(&bytes, self.lines, self.offset, self.bytes)
    }
}

/// Selects the trailing-window slice of `bytes` honoring the byte budget first
/// (when set), otherwise `lines` + `offset`.
fn window(bytes: &[u8], lines: usize, offset: usize, bytes_budget: Option<usize>) -> Vec<u8> {
    if let Some(budget) = bytes_budget {
        let end = bytes.len().saturating_sub(offset);
        let start = end.saturating_sub(budget);
        return bytes[start..end].to_vec();
    }
    let line_count = count_lines(bytes);
    if line_count == 0 {
        return Vec::new();
    }
    let take = lines.min(line_count);
    // Tail the last `take` lines, skipping `offset` further lines from the end.
    let skip_from_end = offset;
    let end_line_index = line_count.saturating_sub(skip_from_end);
    let start_line_index = end_line_index.saturating_sub(take);
    slice_lines(bytes, start_line_index, end_line_index)
}

fn count_lines(bytes: &[u8]) -> usize {
    let mut newline_count = 0;
    for byte in bytes {
        if *byte == b'\n' {
            newline_count += 1;
        }
    }
    newline_count + usize::from(!(bytes.is_empty() || bytes.last() == Some(&b'\n')))
}

fn slice_lines(bytes: &[u8], start_line: usize, end_line: usize) -> Vec<u8> {
    let mut line = 0;
    let mut start_byte = None;
    let mut end_byte = bytes.len();
    for (i, &b) in bytes.iter().enumerate() {
        if line == start_line && start_byte.is_none() {
            start_byte = Some(i);
        }
        if b == b'\n' {
            line += 1;
            if line == end_line {
                end_byte = i + 1;
                break;
            }
        }
    }
    let start = start_byte.unwrap_or(0);
    bytes[start..end_byte].to_vec()
}

/// Strips CSI/OSC ANSI escape sequences (and a few common SGR/SGR-like runs)
/// from the byte stream. This is a best-effort plain-text conversion — it is
/// not a full terminal emulator — and matches the `--plain` default for `tab
/// read`.
fn strip_ansi(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1B {
            out.push(b);
            i += 1;
            continue;
        }
        // CSI: ESC [ ... @-~ (0x40..=0x7E final byte)
        if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                i += 1;
            }
            i = i.saturating_add(1);
            continue;
        }
        // OSC: ESC ] ... BEL (0x07) or ST (ESC \)
        if i + 1 < bytes.len() && bytes[i + 1] == b']' {
            i += 2;
            while i < bytes.len() {
                if bytes[i] == 0x07 {
                    i += 1;
                    break;
                }
                if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                    i += 2;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // Other two-byte escapes (ESC X): drop both bytes.
        i += 2;
    }
    out
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

    pub fn stream(self, stream: &mut std::os::unix::net::UnixStream) -> Result<(), CliError> {
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

fn read_frame_for_watch(stream: &mut std::os::unix::net::UnixStream) -> Result<Frame, CliError> {
    pragma_protocol::read_frame(stream).map_err(CliError::from)
}

use pragma_protocol::{EventFrame, Frame, ServerFrame};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_strips_csi_color() {
        let bytes = b"\x1b[31mhello\x1b[0m world\n".to_vec();
        assert_eq!(strip_ansi(&bytes), b"hello world\n".to_vec());
    }

    #[test]
    fn plain_strips_osc_title() {
        let bytes = b"\x1b]0;title\x07rest\n".to_vec();
        assert_eq!(strip_ansi(&bytes), b"rest\n".to_vec());
    }

    #[test]
    fn plain_strips_osc_with_st_terminator() {
        let bytes = b"\x1b]2;label\x1b\\ok\n".to_vec();
        assert_eq!(strip_ansi(&bytes), b"ok\n".to_vec());
    }

    #[test]
    fn raw_emits_bytes_verbatim() {
        let bytes = b"\x1b[1mraw\x1b[0m\n".to_vec();
        assert_eq!(window(&bytes, usize::MAX, 0, None), bytes);
    }

    #[test]
    fn lines_tails_last_n_lines() {
        let bytes = b"a\nb\nc\nd\ne\n".to_vec();
        let got = window(&bytes, 2, 0, None);
        assert_eq!(got, b"d\ne\n".to_vec());
    }

    #[test]
    fn offset_skips_from_end() {
        let bytes = b"a\nb\nc\nd\ne\n".to_vec();
        let got = window(&bytes, 2, 1, None);
        assert_eq!(got, b"c\nd\n".to_vec());
    }

    #[test]
    fn bytes_budget_selects_tail() {
        let bytes = b"0123456789".to_vec();
        let got = window(&bytes, 0, 0, Some(4));
        assert_eq!(got, b"6789".to_vec());
        let got = window(&bytes, 0, 2, Some(4));
        assert_eq!(got, b"4567".to_vec());
    }

    #[test]
    fn no_trailing_newline_counts_final_line() {
        let bytes = b"a\nb\nc".to_vec();
        assert_eq!(count_lines(&bytes), 3);
        let got = window(&bytes, 1, 0, None);
        assert_eq!(got, b"c".to_vec());
    }

    #[test]
    fn empty_input_yields_empty_window() {
        let bytes = b"".to_vec();
        assert_eq!(window(&bytes, 10, 0, None), b"".to_vec());
    }
}
