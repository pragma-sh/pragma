//! Deterministic terminal-output corpora.
//!
//! Both benchmark tiers must parse *identical* bytes or their numbers cannot be
//! compared: the Rust tier streams a corpus through a real PTY, the TypeScript
//! tier feeds the same corpus to xterm's parser. Generating it from a seeded
//! PRNG here — rather than checking binary fixtures into git — keeps one source
//! of truth and guarantees byte-identical output on every platform.
//!
//! `pragma-bench-load corpus --kind <kind> --bytes <n>` dumps a corpus so the
//! TypeScript tier can read the very same bytes from this very same binary.

use std::fmt::Write as _;

/// A class of terminal output, chosen to stress a different part of a parser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CorpusKind {
    /// Plain 7-bit text. The cheapest path through any parser.
    Ascii,
    /// Dense SGR colour and attribute changes — escape-sequence dispatch cost.
    Sgr,
    /// CJK and combining marks — wide-character and grapheme handling.
    Cjk,
    /// Cursor addressing and erases, as a full-screen TUI redraw emits.
    Redraw,
}

impl CorpusKind {
    /// Parses a corpus kind from its CLI spelling.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ascii" => Some(Self::Ascii),
            "sgr" => Some(Self::Sgr),
            "cjk" => Some(Self::Cjk),
            "redraw" => Some(Self::Redraw),
            _ => None,
        }
    }

    /// The CLI spelling of this kind.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Ascii => "ascii",
            Self::Sgr => "sgr",
            Self::Cjk => "cjk",
            Self::Redraw => "redraw",
        }
    }

    /// Every kind, in report order.
    #[must_use]
    pub fn all() -> [Self; 4] {
        [Self::Ascii, Self::Sgr, Self::Cjk, Self::Redraw]
    }
}

/// A tiny xorshift64* PRNG.
///
/// Deliberately hand-rolled: the corpora must be reproducible across every
/// platform and every future version of the harness, so the generator cannot be
/// allowed to change underneath us when a dependency bumps.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // A zero state is a fixed point for xorshift; fold in a constant so any
        // caller-supplied seed (including 0) produces a live generator.
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform-enough index into `len`. Modulo bias is irrelevant here — the
    /// corpus only needs to be varied and reproducible, not statistically pure.
    fn index(&mut self, len: usize) -> usize {
        usize::try_from(self.next() % (len as u64)).unwrap_or(0)
    }
}

/// Fixed seed. Changing this invalidates every recorded baseline.
const SEED: u64 = 0x5052_4147_4D41_4243;

const WORDS: &[&str] = &[
    "terminal",
    "session",
    "worktree",
    "render",
    "latency",
    "scroll",
    "buffer",
    "pragma",
    "coalesce",
    "viewport",
    "keystroke",
    "throughput",
    "pseudoterminal",
    "frame",
    "socket",
];

const CJK: &[&str] = &[
    "端末",
    "セッション",
    "作業",
    "描画",
    "遅延",
    "巻物",
    "緩衝",
    "画面",
    "文字",
    "幅",
];

/// Combining marks appended to ASCII letters to exercise grapheme clustering.
const COMBINING: &[char] = &['\u{0301}', '\u{0308}', '\u{0327}', '\u{030A}'];

/// Builds at least `bytes` bytes of `kind`, ending on a line boundary.
///
/// The result is always a whole number of lines so a partial escape sequence can
/// never straddle the end and change what the parser sees.
#[must_use]
pub fn build(kind: CorpusKind, bytes: usize) -> Vec<u8> {
    let mut rng = Rng::new(SEED ^ u64::from(kind as u32));
    let mut out = String::with_capacity(bytes + 256);
    let mut row: u16 = 1;
    while out.len() < bytes {
        match kind {
            CorpusKind::Ascii => ascii_line(&mut rng, &mut out),
            CorpusKind::Sgr => sgr_line(&mut rng, &mut out),
            CorpusKind::Cjk => cjk_line(&mut rng, &mut out),
            CorpusKind::Redraw => {
                redraw_line(&mut rng, &mut out, row);
                row = if row >= 24 { 1 } else { row + 1 };
            }
        }
    }
    out.into_bytes()
}

fn ascii_line(rng: &mut Rng, out: &mut String) {
    for i in 0..12 {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[rng.index(WORDS.len())]);
    }
    out.push_str("\r\n");
}

fn sgr_line(rng: &mut Rng, out: &mut String) {
    for i in 0..12 {
        if i > 0 {
            out.push(' ');
        }
        // Alternate 256-colour and truecolour so neither dispatch path dominates.
        if rng.next().is_multiple_of(2) {
            let colour = rng.index(256);
            let _ = write!(out, "\x1b[38;5;{colour}m");
        } else {
            let (r, g, b) = (rng.index(256), rng.index(256), rng.index(256));
            let _ = write!(out, "\x1b[38;2;{r};{g};{b}m");
        }
        if rng.next().is_multiple_of(4) {
            out.push_str("\x1b[1m");
        }
        out.push_str(WORDS[rng.index(WORDS.len())]);
        out.push_str("\x1b[0m");
    }
    out.push_str("\r\n");
}

fn cjk_line(rng: &mut Rng, out: &mut String) {
    for i in 0..10 {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(CJK[rng.index(CJK.len())]);
        // Mix in a combining mark so the parser cannot take a pure-wide fast path.
        if rng.next().is_multiple_of(3) {
            out.push('e');
            out.push(COMBINING[rng.index(COMBINING.len())]);
        }
    }
    out.push_str("\r\n");
}

fn redraw_line(rng: &mut Rng, out: &mut String, row: u16) {
    // Address the row, clear it, repaint it: what a full-screen TUI does per frame.
    let _ = write!(out, "\x1b[{row};1H\x1b[2K");
    for i in 0..8 {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[rng.index(WORDS.len())]);
    }
}

#[cfg(test)]
mod tests {
    use super::{build, CorpusKind};

    #[test]
    fn builds_at_least_the_requested_size() {
        for kind in CorpusKind::all() {
            let corpus = build(kind, 4096);
            assert!(
                corpus.len() >= 4096,
                "{} produced {} bytes",
                kind.name(),
                corpus.len()
            );
        }
    }

    #[test]
    fn is_reproducible() {
        // The whole comparison model depends on this: a baseline recorded last
        // month must describe the same bytes this run parses.
        for kind in CorpusKind::all() {
            assert_eq!(build(kind, 8192), build(kind, 8192), "{}", kind.name());
        }
    }

    #[test]
    fn kinds_differ_from_one_another() {
        assert_ne!(
            build(CorpusKind::Ascii, 4096),
            build(CorpusKind::Sgr, 4096),
            "each kind must seed differently or they measure the same thing"
        );
    }

    #[test]
    fn round_trips_its_cli_name() {
        for kind in CorpusKind::all() {
            assert_eq!(CorpusKind::parse(kind.name()), Some(kind));
        }
        assert_eq!(CorpusKind::parse("nope"), None);
    }
}
