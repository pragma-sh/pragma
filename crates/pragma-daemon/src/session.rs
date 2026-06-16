use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;

use crate::protocol::EventFrame;

const SCROLLBACK_LIMIT: usize = 10_000;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("pty error: {0}")]
    Pty(#[from] anyhow_pty::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("lock poisoned")]
    LockPoisoned,
}

mod anyhow_pty {
    pub type Error = anyhow::Error;
}

type PtyChild = Box<dyn portable_pty::Child + Send>;

pub struct Session {
    id: String,
    /// Absolute path the shell was launched from. Used to identify which
    /// sessions to terminate when their worktree is deleted on disk.
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Option<PtyChild>>,
    scrollback: Mutex<Scrollback>,
    subscribers: Mutex<Vec<Sender<EventFrame>>>,
}

impl Session {
    pub fn spawn(id: String, cwd: String, cols: u16, rows: u16) -> Result<Arc<Self>, SessionError> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(shell_path());
        command.arg("-l");
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(command)?;
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        drop(pair.slave);

        let session = Arc::new(Self {
            id,
            cwd,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(Some(child)),
            scrollback: Mutex::new(Scrollback::new(SCROLLBACK_LIMIT)),
            subscribers: Mutex::new(Vec::new()),
        });
        Self::start_reader(Arc::clone(&session), reader);
        Ok(session)
    }

    pub fn attach(&self) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), SessionError> {
        // Hold the scrollback lock while registering the subscriber so the reader
        // thread cannot broadcast an event that lands in both the snapshot and the
        // channel — that would replay duplicated output to the freshly attached
        // client. Taking both locks together makes attach atomic w.r.t. broadcast.
        let scrollback_guard = self
            .scrollback
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?;
        let (tx, rx) = mpsc::channel();
        self.subscribers
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .push(tx);
        let scrollback = scrollback_guard.frames();
        Ok((scrollback, rx))
    }

    pub fn write(&self, data: &str) -> Result<(), SessionError> {
        let mut writer = self.writer.lock().map_err(|_| SessionError::LockPoisoned)?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.master
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }

    pub fn kill(&self) -> Result<(), SessionError> {
        if let Some(mut child) = self
            .child
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .take()
        {
            child.kill()?;
        }
        Ok(())
    }

    /// Returns the absolute path the shell was launched from.
    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    fn start_reader(session: Arc<Self>, mut reader: Box<dyn Read + Send>) {
        thread::spawn(move || {
            let mut decoder = Utf8Carry::default();
            let mut osc = OscParser::default();
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for chunk in osc.push(&buf[..n]) {
                            match chunk {
                                OscChunk::Output(bytes) => {
                                    for data in decoder.push(&bytes) {
                                        session.broadcast(&EventFrame::Output {
                                            session_id: session.id.clone(),
                                            data,
                                        });
                                    }
                                }
                                OscChunk::Title(title) => {
                                    session.broadcast(&EventFrame::Title {
                                        session_id: session.id.clone(),
                                        title,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            for chunk in osc.finish() {
                match chunk {
                    OscChunk::Output(bytes) => {
                        for data in decoder.push(&bytes) {
                            session.broadcast(&EventFrame::Output {
                                session_id: session.id.clone(),
                                data,
                            });
                        }
                    }
                    OscChunk::Title(title) => {
                        session.broadcast(&EventFrame::Title {
                            session_id: session.id.clone(),
                            title,
                        });
                    }
                }
            }
            if let Some(data) = decoder.finish() {
                session.broadcast(&EventFrame::Output {
                    session_id: session.id.clone(),
                    data,
                });
            }
            let code = session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.take())
                .and_then(|mut child| child.wait().ok())
                .map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            session.broadcast(&EventFrame::Exit {
                session_id: session.id.clone(),
                code,
            });
        });
    }

    fn broadcast(&self, event: &EventFrame) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.push(event.clone());
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }
}

#[derive(Default)]
pub struct Utf8Carry {
    carry: Vec<u8>,
}

impl Utf8Carry {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.carry.extend_from_slice(bytes);
        match std::str::from_utf8(&self.carry) {
            Ok(text) => {
                let out = text.to_string();
                self.carry.clear();
                vec![out]
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid == 0 {
                    return Vec::new();
                }
                let out = String::from_utf8(self.carry[..valid].to_vec()).ok();
                let rest = self.carry[valid..].to_vec();
                self.carry = rest;
                out.into_iter().collect()
            }
        }
    }

    pub fn finish(self) -> Option<String> {
        if self.carry.is_empty() {
            None
        } else {
            String::from_utf8(self.carry).ok()
        }
    }
}

/// One chunk produced by [`OscParser`]. `Output` bytes are UTF-8-encoded
/// terminal output (with any OSC 0/2 sequences already stripped out); `Title`
/// is the extracted tab title for the frontend to apply (or ignore if the user
/// has manually renamed the tab).
#[derive(Debug, PartialEq, Eq)]
pub enum OscChunk {
    Output(Vec<u8>),
    Title(String),
}

/// A tiny state machine that scans raw PTY output for shell-emitted window
/// title sequences and strips them out.
///
/// Terminals use the OSC 0 (`ESC ]0;...BEL/ST`) and OSC 2 (`ESC ]2;...BEL/ST`)
/// sequences to set the window title. `PROMPT_COMMAND` / `precmd` / `preexec`
/// hook into these to surface useful labels like `user@host: ~/repo (main)`,
/// and we want the same in the Pragma tab strip. Every other byte — including
/// other OSC numbers (icon name, color queries, hyperlinks, …) and other ANSI
/// escape sequences (CSI, DCS, …) — is passed through unchanged so the terminal
/// renderer (xterm) keeps working as it does today.
#[derive(Default)]
pub struct OscParser {
    /// State of the parser — see the impl for the transitions.
    state: OscState,
    /// Bytes tentatively held while we determine whether they're part of an
    /// OSC 0/2 sequence or normal text. Flushed on transition out of
    /// [`OscState::Esc`] / [`OscState::OscNumber`].
    pending: Vec<u8>,
    /// The OSC number being collected (only valid in [`OscState::OscBody`]).
    osc_number: u8,
    /// Title body bytes (only valid in [`OscState::OscBody`]).
    body: Vec<u8>,
}

#[derive(Default, PartialEq, Eq)]
enum OscState {
    /// Normal text — every byte flushes to the output stream.
    #[default]
    Ground,
    /// Saw `ESC` outside an OSC sequence — the next byte decides whether
    /// this is the start of an OSC (`ESC ]`) or some other escape we should
    /// pass through.
    Esc,
    /// Saw `ESC ]` — the next byte decides whether this is OSC 0/2 (titles)
    /// or some other `ESC ]`-prefixed sequence (DCS) we should pass through.
    Osc,
    /// Saw `ESC ] N` — collecting optional extra digits of the OSC number
    /// until a `;` arrives.
    OscNumber,
    /// Inside the body of an OSC 0/2 sequence, collecting title bytes until
    /// the terminator (`BEL` or `ESC \`).
    OscBody,
    /// Inside the body of an OSC 0/2 sequence and just saw `ESC` — the next
    /// byte must be `\` for the string terminator (`ESC \`) to complete the
    /// sequence; anything else is a body byte after a literal `ESC`.
    OscSt,
}

impl OscParser {
    /// Feeds raw bytes from a single `read` call. Returns zero or more chunks
    /// in input order: each `Output` chunk is bytes that are *definitely* not
    /// part of an OSC 0/2 sequence, and each `Title` is an extracted title.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<OscChunk> {
        let mut out = Vec::new();
        // Coalesce consecutive text bytes into a single `Output` chunk so
        // steady-state PTY output (which is mostly plain text) doesn't
        // allocate one `Vec` per byte.
        let mut text_buf = Vec::new();
        // A `while` loop with an explicit index lets us re-process the
        // current byte after a state change (e.g. rolling an `ESC` we
        // tentatively held back into the OSC body and re-handling the
        // next byte as body content).
        let mut i = 0;
        while i < bytes.len() {
            let byte = bytes[i];
            match self.state {
                OscState::Ground => {
                    if byte == 0x1B {
                        // Tentative — hold the `ESC` until we know whether
                        // it's the start of an OSC 0/2 we should strip or
                        // some other escape we should pass through.
                        if !text_buf.is_empty() {
                            out.push(OscChunk::Output(std::mem::take(&mut text_buf)));
                        }
                        self.pending.push(byte);
                        self.state = OscState::Esc;
                    } else {
                        text_buf.push(byte);
                    }
                }
                OscState::Esc => {
                    if byte == b']' {
                        // Tentative OSC start — hold the `ESC` until we know
                        // whether this is an OSC 0/2 we should strip.
                        self.pending.push(byte);
                        self.state = OscState::Osc;
                    } else {
                        // Not an OSC — emit the held `ESC` plus this byte
                        // as plain output and resume.
                        let mut flushed = std::mem::take(&mut self.pending);
                        flushed.push(byte);
                        out.push(OscChunk::Output(flushed));
                        self.state = OscState::Ground;
                    }
                }
                OscState::Osc => {
                    if byte == b'0' || byte == b'2' {
                        self.pending.push(byte);
                        self.osc_number = byte - b'0';
                        self.state = OscState::OscNumber;
                    } else {
                        // Not OSC 0/2 — emit the held `ESC ] <byte>` as plain
                        // output (DCS and other OSC numbers are still part
                        // of the terminal stream for xterm to handle).
                        let mut flushed = std::mem::take(&mut self.pending);
                        flushed.push(byte);
                        out.push(OscChunk::Output(flushed));
                        self.state = OscState::Ground;
                    }
                }
                OscState::OscNumber => {
                    if byte == b';' {
                        self.pending.push(byte);
                        self.body.clear();
                        self.state = OscState::OscBody;
                    } else if byte.is_ascii_digit() {
                        // OSC numbers longer than one digit are not
                        // interesting for tab titles; keep the digits as
                        // pending until we see the `;` or give up.
                        self.pending.push(byte);
                    } else {
                        // Malformed — flush the held `ESC ] N <byte>` to the
                        // output stream and resume.
                        let mut flushed = std::mem::take(&mut self.pending);
                        flushed.push(byte);
                        out.push(OscChunk::Output(flushed));
                        self.state = OscState::Ground;
                    }
                }
                OscState::OscBody => {
                    if byte == 0x07 {
                        // BEL terminator — emit the title (only OSC 0/2;
                        // other numbers were filtered out above).
                        if matches!(self.osc_number, 0 | 2) {
                            let title = String::from_utf8_lossy(&self.body).into_owned();
                            out.push(OscChunk::Title(title));
                        }
                        self.reset();
                    } else if byte == 0x1B {
                        // Possible start of the ST (`ESC \`) terminator. Hold
                        // the `ESC` and wait for its companion.
                        self.state = OscState::OscSt;
                    } else {
                        self.body.push(byte);
                    }
                }
                OscState::OscSt => {
                    if byte == b'\\' {
                        // ST terminator — emit the title.
                        if matches!(self.osc_number, 0 | 2) {
                            let title = String::from_utf8_lossy(&self.body).into_owned();
                            out.push(OscChunk::Title(title));
                        }
                        self.reset();
                    } else {
                        // The `ESC` was actually a body byte (some shells
                        // allow embedded escapes inside OSC bodies). Roll
                        // it into the body, switch back to OscBody, and
                        // re-process this same byte as body content.
                        self.body.push(0x1B);
                        self.state = OscState::OscBody;
                        continue;
                    }
                }
            }
            i += 1;
        }
        if !text_buf.is_empty() {
            out.push(OscChunk::Output(text_buf));
        }
        out
    }

    /// Drains any bytes still held in pending state at end of stream. Returns
    /// them as an `Output` chunk — they were either an incomplete OSC sequence
    /// or a trailing `ESC` whose companion never arrived.
    pub fn finish(&mut self) -> Vec<OscChunk> {
        let mut out = Vec::new();
        if !self.pending.is_empty() {
            out.push(OscChunk::Output(std::mem::take(&mut self.pending)));
        }
        // An in-progress body (no terminator arrived before EOF) is discarded:
        // the title is incomplete and emitting a half-built one would be worse
        // than the next session's clean OSC sequence.
        self.reset();
        out
    }

    fn reset(&mut self) {
        self.state = OscState::Ground;
        self.pending.clear();
        self.osc_number = 0;
        self.body.clear();
    }
}

pub struct Scrollback {
    limit: usize,
    frames: VecDeque<EventFrame>,
}

impl Scrollback {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            frames: VecDeque::new(),
        }
    }

    pub fn push(&mut self, frame: EventFrame) {
        if self.frames.len() == self.limit {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
    }

    pub fn frames(&self) -> Vec<EventFrame> {
        self.frames.iter().cloned().collect()
    }
}

fn shell_path() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{OscChunk, OscParser, Scrollback, Utf8Carry};
    use crate::protocol::EventFrame;

    #[test]
    fn preserves_utf8_boundaries() {
        let mut carry = Utf8Carry::default();
        assert!(carry.push(&[0xf0, 0x9f]).is_empty());
        assert_eq!(carry.push(&[0x98, 0x80]), vec!["😀".to_string()]);
    }

    #[test]
    fn scrollback_is_bounded() {
        let mut scrollback = Scrollback::new(2);
        for data in ["one", "two", "three"] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data: data.to_string(),
            });
        }
        assert_eq!(scrollback.frames().len(), 2);
    }

    fn feed(bytes: &[u8]) -> Vec<OscChunk> {
        let mut parser = OscParser::default();
        parser.push(bytes)
    }

    fn split(chunks: Vec<OscChunk>) -> (Vec<Vec<u8>>, Vec<String>) {
        let mut outputs = Vec::new();
        let mut titles = Vec::new();
        for chunk in chunks {
            match chunk {
                OscChunk::Output(bytes) => outputs.push(bytes),
                OscChunk::Title(title) => titles.push(title),
            }
        }
        (outputs, titles)
    }

    #[test]
    fn strips_osc0_with_bel_terminator() {
        let mut parser = OscParser::default();
        let chunks = parser.push(b"\x1b]0;hello\x07rest");
        let (outputs, titles) = split(chunks);
        let output_bytes: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(output_bytes, b"rest".to_vec());
        assert_eq!(titles, vec!["hello".to_string()]);
    }

    #[test]
    fn strips_osc2_with_bel_terminator() {
        let mut parser = OscParser::default();
        let chunks = parser.push(b"\x1b]2;user@host: ~/repo\x07");
        let (outputs, titles) = split(chunks);
        assert!(outputs.is_empty(), "OSC body must not reach the terminal");
        assert_eq!(titles, vec!["user@host: ~/repo".to_string()]);
    }

    #[test]
    fn strips_osc0_with_st_terminator() {
        // ST is `ESC \` (0x1B 0x5C). The shell emits this as the more
        // pedantically-correct terminator and some programs default to it.
        let mut parser = OscParser::default();
        let chunks = parser.push(b"\x1b]0;graceful\x1b\\after");
        let (outputs, titles) = split(chunks);
        let output_bytes: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(output_bytes, b"after".to_vec());
        assert_eq!(titles, vec!["graceful".to_string()]);
    }

    #[test]
    fn splits_osc_across_reads() {
        // A long-running prompt can land the OSC sequence across multiple
        // PTY reads; the parser must still strip it.
        let mut parser = OscParser::default();
        let mut output_bytes = Vec::new();
        let mut extracted = Vec::new();
        for chunk in [
            b"\x1b]0;long ti".as_slice(),
            b"tle with \x07tail".as_slice(),
        ] {
            for parsed in parser.push(chunk) {
                match parsed {
                    OscChunk::Output(bytes) => output_bytes.extend(bytes),
                    OscChunk::Title(title) => extracted.push(title),
                }
            }
        }
        assert_eq!(output_bytes, b"tail".to_vec());
        assert_eq!(extracted, vec!["long title with ".to_string()]);
    }

    #[test]
    fn leaves_osc1_icon_name_alone() {
        // OSC 1 (icon name) must reach xterm unchanged — we only care about
        // window title (OSC 0/2) for the tab strip.
        let chunks = feed(b"\x1b]1;icon\x07");
        let (outputs, titles) = split(chunks);
        let output_bytes: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(output_bytes, b"\x1b]1;icon\x07".to_vec());
        assert!(titles.is_empty());
    }

    #[test]
    fn leaves_non_osc_escape_sequences_alone() {
        // CSI cursor move (`ESC [ 2 J`) and other escapes must pass through.
        let chunks = feed(b"\x1b[2J\x1b[Hprompt$ ");
        let (outputs, titles) = split(chunks);
        let output_bytes: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(output_bytes, b"\x1b[2J\x1b[Hprompt$ ".to_vec());
        assert!(titles.is_empty());
    }

    #[test]
    fn leaves_lone_esc_alone() {
        // A trailing `ESC` whose companion never arrives (e.g. user mashing
        // keys) should still flush as a literal byte once the stream ends.
        let mut parser = OscParser::default();
        let push_chunks = parser.push(b"hello\x1b");
        let (mut outputs, _) = split(push_chunks);
        let (trailing_outputs, _) = split(parser.finish());
        outputs.extend(trailing_outputs);
        let final_output: Vec<u8> = outputs.into_iter().flatten().collect();
        assert_eq!(final_output, b"hello\x1b".to_vec());
    }

    #[test]
    fn emits_last_title_when_shell_sends_multiple() {
        // Many prompts re-emit OSC 0 on every command; the latest one wins.
        let mut parser = OscParser::default();
        let _ = parser.push(b"\x1b]0;first\x07");
        let _ = parser.push(b"\x1b]0;second\x07");
        let (_, titles) = split(parser.finish());
        assert!(titles.is_empty());
        // To get the second title we need to feed the OSC body to the parser
        // and look at its chunks before finish — verify the latest-wins
        // behavior by replaying both into a single push and checking.
        let mut parser = OscParser::default();
        let chunks = parser.push(b"\x1b]0;first\x07\x1b]0;second\x07");
        let (_, titles) = split(chunks);
        assert_eq!(titles, vec!["first".to_string(), "second".to_string()]);
    }
}
