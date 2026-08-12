//! Slicing and plain-text rendering of raw terminal scrollback.
//!
//! The host keeps scrollback as a capped buffer of raw output bytes — not
//! history, and not line-addressed. Turning that into "the last N lines as
//! readable text" is the same problem for `pragma-cli tab read` and for the
//! host's own `fanout read`, so it lives here rather than being written twice
//! with two slightly different escape strippers.

/// Selects the trailing-window slice of `bytes` honoring the byte budget first
/// (when set), otherwise `lines` + `offset`.
#[must_use]
pub fn window(bytes: &[u8], lines: usize, offset: usize, bytes_budget: Option<usize>) -> Vec<u8> {
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
#[must_use]
pub fn strip_ansi(bytes: &[u8]) -> Vec<u8> {
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

/// Renders a scrollback window as plain text: escapes stripped, then the
/// trailing `lines` selected.
#[must_use]
pub fn plain_text(bytes: &[u8], lines: usize) -> String {
    let stripped = strip_ansi(bytes);
    String::from_utf8_lossy(&window(&stripped, lines, 0, None)).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{count_lines, plain_text, strip_ansi, window};

    #[test]
    fn plain_strips_csi_color() {
        assert_eq!(
            strip_ansi(b"\x1b[31mhello\x1b[0m world\n"),
            b"hello world\n".to_vec()
        );
    }

    #[test]
    fn plain_strips_osc_title_and_st_terminator() {
        assert_eq!(strip_ansi(b"\x1b]0;title\x07rest\n"), b"rest\n".to_vec());
        assert_eq!(strip_ansi(b"\x1b]2;label\x1b\\ok\n"), b"ok\n".to_vec());
    }

    #[test]
    fn window_tails_lines_and_honours_offset_and_byte_budget() {
        assert_eq!(window(b"a\nb\nc\nd\ne\n", 2, 0, None), b"d\ne\n".to_vec());
        assert_eq!(window(b"a\nb\nc\nd\ne\n", 2, 1, None), b"c\nd\n".to_vec());
        assert_eq!(window(b"0123456789", 0, 0, Some(4)), b"6789".to_vec());
        assert_eq!(window(b"0123456789", 0, 2, Some(4)), b"4567".to_vec());
    }

    #[test]
    fn a_final_line_without_a_newline_still_counts() {
        assert_eq!(count_lines(b"a\nb\nc"), 3);
        assert_eq!(window(b"a\nb\nc", 1, 0, None), b"c".to_vec());
    }

    #[test]
    fn an_empty_buffer_yields_an_empty_window() {
        assert!(window(b"", 10, 0, None).is_empty());
    }

    #[test]
    fn plain_text_strips_then_tails() {
        assert_eq!(plain_text(b"\x1b[31ma\x1b[0m\nb\nc\n", 2), "b\nc\n");
    }
}
