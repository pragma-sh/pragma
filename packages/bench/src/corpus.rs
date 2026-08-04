//! The scrollable content both payloads render.
//!
//! Shared by `pragma-bench tui` (which owns the scroll itself) and
//! `pragma-bench lines` (which dumps the same corpus into xterm's scrollback),
//! so the two scroll scenarios move over identical text and a difference
//! between them is a difference in the path, not in the payload.

/// Rows between two marker lines. Small enough that a marker is on screen for
/// most viewport heights, large enough that markers stay countable by eye.
pub const MARKER_EVERY: usize = 50;

/// Default corpus height. The benchmark scrolls a few hundred lines at most, so
/// this leaves the run far away from either end — a scroll that hits a boundary
/// stops moving and would be recorded as a dropped sample rather than a slow one.
pub const DEFAULT_LINES: usize = 5000;

/// Words cycled through the corpus so no two adjacent rows are identical.
const WORDS: [&str; 8] = [
    "resolve", "flush", "paint", "commit", "measure", "damage", "viewport", "raster",
];

/// Body text for `index`, without the line-number gutter.
///
/// Deliberately varied per line: a corpus of identical rows lets a renderer's
/// damage tracking skip work no real terminal session gets to skip.
#[must_use]
pub fn body(index: usize) -> String {
    if is_marker(index) {
        let bar = "━".repeat(12);
        return format!("{bar} MARKER {index} — {index} lines scrolled {bar}");
    }
    let word = WORDS[index % WORDS.len()];
    let bar = "▁▂▃▄▅▆▇█"
        .chars()
        .cycle()
        .skip(index % 8)
        .take(8)
        .collect::<String>();
    format!("{bar} {word} row {index:05} · lorem ipsum dolor sit amet consectetur adipiscing elit")
}

/// Whether `index` is one of the every-[`MARKER_EVERY`] milestone rows.
#[must_use]
pub fn is_marker(index: usize) -> bool {
    index.is_multiple_of(MARKER_EVERY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_rows_name_their_own_index() {
        assert!(body(1300).contains("MARKER 1300"));
        assert!(!body(1301).contains("MARKER"));
    }

    #[test]
    fn bodies_differ_between_adjacent_rows() {
        assert_ne!(body(11), body(12));
    }

    #[test]
    fn markers_land_on_the_documented_interval() {
        assert!(is_marker(0));
        assert!(is_marker(MARKER_EVERY));
        assert!(!is_marker(MARKER_EVERY - 1));
    }
}
