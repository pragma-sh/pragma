use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use pragma_constants::CONSTANTS;
use pragma_platform::{process, shell};
use serde::Deserialize;
use thiserror::Error;

use pragma_protocol::EventFrame;

const SCROLLBACK_LIMIT: usize = 10_000;

/// Hard cap on the total bytes of buffered `Output` data a session's scrollback
/// may hold, independent of the frame-count limit. The frame-count cap alone is
/// not a memory bound: output coalescing means a single frame can carry up to
/// [`OUTPUT_COALESCE_MAX_BYTES`] (256 KiB), so 10 000 frames could legally pin
/// ~2.5 GiB per session. A long-lived, output-heavy session (an agent run
/// flooding the terminal for hours) really does accumulate that, and the
/// server — a daemonized process built with `panic = "abort"` — then dies to
/// macOS memory pressure or an allocation failure, taking every other session
/// with it. 8 MiB is far more history than a terminal ever replays on attach
/// while keeping worst-case scrollback memory per session small.
const SCROLLBACK_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Size of the buffer used to read raw bytes from the PTY master. A full-screen
/// redraw from a TUI (e.g. a mouse-tracking app repainting its whole grid on a
/// scroll report) is tens of KB; reading it in one syscall instead of many small
/// chunks keeps a single redraw as a single output frame, so it crosses the
/// socket + IPC boundary and reaches xterm as one write/parse/paint pass instead
/// of several. Returns diminish sharply past ~64 KB: a PTY master `read` returns
/// whatever the kernel has buffered *right now* (it never blocks to fill the
/// buffer), and the kernel's per-PTY buffer rarely holds more than a few tens of
/// KB, so a larger buffer just sits unused. A bigger buffer also never adds
/// latency — it only ever caps a single read, never delays one.
const READ_BUFFER_BYTES: usize = 64 * 1024;

/// Trailing-throttle window for coalescing PTY output into fewer, larger frames.
/// The first output after an idle period is flushed immediately (zero added
/// latency — this is the keystroke-echo path); after that, further output is
/// batched and flushed at most once per interval. During a burst (a scroll flood
/// repainting the grid, a `cat` of a large file) this collapses many fragmented
/// reads into one frame per tick, cutting the number of JSON-encoded socket
/// frames, Tauri IPC messages, and xterm parse/paint passes. Isolated output is
/// never delayed; only back-to-back output is merged.
const OUTPUT_COALESCE_INTERVAL: Duration = Duration::from_millis(8);

/// Hard cap on buffered-but-unflushed output. A sustained flood is flushed as
/// soon as it reaches this size regardless of the interval, bounding memory and
/// keeping individual frames well under the protocol's 16 MiB frame limit.
const OUTPUT_COALESCE_MAX_BYTES: usize = 256 * 1024;

/// Maximum number of reader messages waiting for the coalescer. Each output
/// message comes from one bounded PTY read, so this also bounds queued bytes.
/// A full queue backpressures the PTY reader; the coalescer never waits on a
/// subscriber, so a slow client cannot make that wait indefinite.
const OUTPUT_CHANNEL_CAPACITY: usize = 8;

/// Number of live events one attached client may lag behind. Once full, the
/// subscriber is disconnected and can reattach from bounded scrollback.
const SUBSCRIBER_CHANNEL_CAPACITY: usize = 32;

/// Maximum raw title bytes retained while waiting for an OSC terminator.
/// Longer or malformed candidates are replayed as ordinary terminal output.
const OSC_TITLE_MAX_BYTES: usize = 4 * 1024;

/// `ESC ] N ;` is the longest prefix retained for an OSC 0/2 candidate.
const OSC_PENDING_MAX_BYTES: usize = 4;

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
type ExitHandler = Box<dyn FnOnce(&Arc<Session>) + Send>;

/// Whether [`Session::live_root_pid`] has already reaped the child's exit
/// status, and if so, what it was.
#[derive(Default)]
enum ReapedExitCode {
    #[default]
    NotReaped,
    Reaped(Option<i32>),
}

/// A unit of work handed from the PTY reader thread to the coalescer thread.
/// `Output` carries raw, OSC-stripped terminal bytes (no UTF-8 decode — output
/// ships as binary all the way to xterm); `Title` and `Exit` are control events
/// the coalescer forwards in order (flushing any buffered output first so
/// ordering is preserved).
#[derive(Debug)]
enum OutputMsg {
    Output(Vec<u8>),
    Title(String),
    Exit(Option<i32>),
}

/// Accumulates consecutive PTY output so a burst can be broadcast as a single
/// frame. Concatenating output is semantically identical to delivering each
/// piece separately (it is one byte stream to xterm), but lets a burst cross the
/// socket/IPC boundary and reach the renderer once instead of once per fragment.
/// See [`OUTPUT_COALESCE_INTERVAL`].
#[derive(Default)]
struct OutputCoalescer {
    pending: Vec<u8>,
}

impl OutputCoalescer {
    fn push(&mut self, mut data: Vec<u8>) {
        if self.pending.is_empty() {
            self.pending = data;
        } else {
            self.pending.append(&mut data);
        }
    }

    fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Takes the buffered output, or `None` when nothing is pending.
    fn flush(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

pub struct Session {
    id: String,
    worktree_id: String,
    root_pid: Option<u32>,
    /// Absolute path the shell was launched from. Used to identify which
    /// sessions to terminate when their worktree is deleted on disk.
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Option<PtyChild>>,
    /// Exit code reaped by [`Session::live_root_pid`], if it won the race with
    /// the reader thread's own `wait()`. `try_wait` issues a `waitpid(WNOHANG)`
    /// on Unix, so if it observes exit at the exact moment the shell dies it
    /// reaps the zombie and consumes the exit status; a later `wait()` call by
    /// the reader thread would then get `ECHILD` and silently lose the code.
    /// Stashing it here lets the reader thread recover it instead of re-waiting.
    reaped_exit_code: Mutex<ReapedExitCode>,
    scrollback: Mutex<Scrollback>,
    subscribers: Mutex<Vec<SyncSender<EventFrame>>>,
    output_tx: SyncSender<OutputMsg>,
    exited: AtomicBool,
    on_exit: Mutex<Option<ExitHandler>>,
}

impl Session {
    /// Spawns a session and invokes `on_exit` after its final exit event is recorded.
    pub fn spawn_with_exit_handler(
        id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        server_socket: &str,
        on_exit: impl FnOnce(&Arc<Session>) + Send + 'static,
    ) -> Result<Arc<Self>, SessionError> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let launch = shell::resolve_launch(project_shell(&cwd).as_deref());
        let mut command = CommandBuilder::new(&launch.program);
        command.args(&launch.args);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("PRAGMA_TAB_ID", &id);
        command.env("PRAGMA_WORKTREE_ID", &worktree_id);
        command.env("PRAGMA_DAEMON_SOCKET", server_socket);
        command.env("PRAGMA_SERVER_SOCKET", server_socket);
        if let Some(gateway) = gateway_env(server_socket) {
            command.env("PRAGMA_GATEWAY_URL", gateway.url);
            command.env("PRAGMA_GATEWAY_TOKEN", gateway.token);
        }
        if let Some(cli_path) = pragma_cli_path() {
            command.env("PRAGMA_CLI", &cli_path);
            command.env("PATH", path_with_cli_dir(&cli_path));
        }
        let child = pair.slave.spawn_command(command)?;
        let root_pid = child.process_id();
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        drop(pair.slave);
        let (output_tx, output_rx) = mpsc::sync_channel::<OutputMsg>(OUTPUT_CHANNEL_CAPACITY);

        let session = Arc::new(Self {
            id,
            worktree_id,
            root_pid,
            cwd,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(Some(child)),
            reaped_exit_code: Mutex::new(ReapedExitCode::NotReaped),
            scrollback: Mutex::new(Scrollback::new(SCROLLBACK_LIMIT)),
            subscribers: Mutex::new(Vec::new()),
            output_tx,
            exited: AtomicBool::new(false),
            on_exit: Mutex::new(Some(Box::new(on_exit))),
        });
        Self::start_coalescer(Arc::clone(&session), output_rx);
        Self::start_reader(Arc::clone(&session), reader);
        Ok(session)
    }

    /// Returns whether the shell's exit event has been recorded.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    pub fn attach(
        &self,
        cursor: Option<u64>,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), SessionError> {
        // Hold the scrollback lock while registering the subscriber so the reader
        // thread cannot broadcast an event that lands in both the snapshot and the
        // channel — that would replay duplicated output to the freshly attached
        // client. Taking both locks together makes attach atomic w.r.t. broadcast.
        let scrollback_guard = self
            .scrollback
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?;
        let (tx, rx) = mpsc::sync_channel(SUBSCRIBER_CHANNEL_CAPACITY);
        self.subscribers
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .push(tx);
        let scrollback = scrollback_guard.frames_since(&self.id, cursor);
        Ok((scrollback, rx))
    }

    pub fn write(&self, data: &str) -> Result<(), SessionError> {
        self.write_bytes(data.as_bytes())
    }

    /// True when the PTY output observed so far contains `needle` (for example
    /// the alternate-screen escape a TUI emits once it takes the terminal).
    pub fn output_contains(&self, needle: &[u8]) -> bool {
        self.scrollback
            .lock()
            .is_ok_and(|scrollback| scrollback.output_contains(needle))
    }

    pub fn write_bytes(&self, data: &[u8]) -> Result<(), SessionError> {
        let mut writer = self.writer.lock().map_err(|_| SessionError::LockPoisoned)?;
        writer.write_all(data)?;
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

    /// Ends the shell and everything it spawned.
    ///
    /// `portable_pty`'s own `Child::kill` only sends `SIGHUP` to the shell's
    /// own pid on Unix — anything the shell forked (a backgrounded dev
    /// server, a `zsh-async` prompt worker, an unrelated disowned job) is
    /// orphaned to launchd instead of dying with it, which is how sessions
    /// closed in the UI leave processes running for the rest of the machine's
    /// uptime. [`process::kill_process_tree`] instead walks and kills the
    /// shell's whole descendant tree, which also reaches a backgrounded job
    /// that job control moved into its own process group.
    pub fn kill(&self) -> Result<(), SessionError> {
        let Some(mut child) = self
            .child
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .take()
        else {
            return Ok(());
        };
        if let Some(pid) = self.root_pid {
            let _ = process::kill_process_tree(pid);
        } else {
            // No pid recorded (spawn-time failure to read it back) — fall
            // back to portable_pty's own single-process signal rather than
            // leaving the shell running with nothing to address it by.
            let _ = child.kill();
        }
        // Reap now instead of letting `child` drop unwaited: `portable_pty`'s
        // Unix `Child` is a bare `std::process::Child`, whose `Drop` does not
        // wait() on it, so an un-reaped kill leaves a zombie pinned until the
        // server itself exits. The reader thread's own post-EOF `wait()`
        // no longer has a child to reap here — `take()` above already moved
        // it out from under that path.
        let _ = child.wait();
        Ok(())
    }

    /// Returns the absolute path the shell was launched from.
    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    /// Returns terminal tab id used as daemon session id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Returns worktree owning this terminal session.
    pub fn worktree_id(&self) -> &str {
        &self.worktree_id
    }

    /// Returns root login-shell PID only while child is still running. Exited,
    /// unattached sessions can remain registered until replay; excluding them
    /// prevents a recycled PID from attributing an unrelated host listener.
    pub fn live_root_pid(&self) -> Option<u32> {
        let mut child = self.child.lock().ok()?;
        match child.as_mut()?.try_wait() {
            Ok(None) => self.root_pid,
            Ok(Some(status)) => {
                // We just reaped the zombie ourselves — stash the exit code so
                // the reader thread's later `wait()` (which would otherwise
                // get `ECHILD` and lose it) can recover it instead.
                let code = i32::try_from(status.exit_code()).unwrap_or(i32::MAX);
                if let Ok(mut reaped) = self.reaped_exit_code.lock() {
                    *reaped = ReapedExitCode::Reaped(Some(code));
                }
                None
            }
            Err(_) => None,
        }
    }

    fn start_reader(session: Arc<Self>, mut reader: Box<dyn Read + Send>) {
        // The reader thread only strips OSC titles; a dedicated coalescer thread
        // batches the resulting output so a redraw burst becomes one broadcast
        // frame instead of many (see OUTPUT_COALESCE_INTERVAL). Output stays raw
        // bytes the whole way — no UTF-8 decode — and xterm handles any partial
        // multi-byte sequence split across frames itself.
        let tx = session.output_tx.clone();
        thread::spawn(move || {
            let mut osc = OscParser::default();
            let mut buf = vec![0_u8; READ_BUFFER_BYTES].into_boxed_slice();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for chunk in osc.push(&buf[..n]) {
                            let msg = match chunk {
                                OscChunk::Output(bytes) => OutputMsg::Output(bytes),
                                OscChunk::Title(title) => OutputMsg::Title(title),
                            };
                            // The coalescer thread is gone (session torn down) —
                            // stop reading.
                            if tx.send(msg).is_err() {
                                return;
                            }
                        }
                    }
                }
            }
            for chunk in osc.finish() {
                let msg = match chunk {
                    OscChunk::Output(bytes) => OutputMsg::Output(bytes),
                    OscChunk::Title(title) => OutputMsg::Title(title),
                };
                let _ = tx.send(msg);
            }
            let cached_code = session.reaped_exit_code.lock().ok().and_then(|mut reaped| {
                match std::mem::take(&mut *reaped) {
                    ReapedExitCode::Reaped(code) => Some(code),
                    ReapedExitCode::NotReaped => None,
                }
            });
            let code = match cached_code {
                Some(code) => code,
                None => session
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.take())
                    .and_then(|mut child| child.wait().ok())
                    .map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX)),
            };
            let _ = tx.send(OutputMsg::Exit(code));
        });
    }

    /// Drains [`OutputMsg`]s from the reader thread and broadcasts them, merging
    /// consecutive output with a trailing throttle. Output that arrives after an
    /// idle gap is flushed immediately (no added echo latency); a burst is
    /// coalesced and flushed at most once per [`OUTPUT_COALESCE_INTERVAL`] (or
    /// sooner if it reaches [`OUTPUT_COALESCE_MAX_BYTES`]). `Title`/`Exit` flush
    /// any buffered output first so frame ordering is preserved.
    fn start_coalescer(session: Arc<Self>, rx: Receiver<OutputMsg>) {
        thread::spawn(move || {
            let mut coalescer = OutputCoalescer::default();
            // Seed `last_flush` in the past so the first output flushes at once.
            let mut last_flush = instant_before_coalesce_window();
            loop {
                let msg = if coalescer.pending_len() == 0 {
                    // Nothing buffered — block until there is output to send.
                    match rx.recv() {
                        Ok(msg) => msg,
                        Err(_) => break,
                    }
                } else {
                    let elapsed = last_flush.elapsed();
                    if elapsed >= OUTPUT_COALESCE_INTERVAL {
                        session.broadcast_output(coalescer.flush());
                        last_flush = Instant::now();
                        continue;
                    }
                    // `elapsed < OUTPUT_COALESCE_INTERVAL` here (the `>=` case
                    // flushed and continued above), so the remaining window is
                    // positive; fall back to zero defensively if it is not.
                    let remaining = OUTPUT_COALESCE_INTERVAL
                        .checked_sub(elapsed)
                        .unwrap_or(Duration::ZERO);
                    match rx.recv_timeout(remaining) {
                        Ok(msg) => msg,
                        Err(RecvTimeoutError::Timeout) => {
                            session.broadcast_output(coalescer.flush());
                            last_flush = Instant::now();
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            session.broadcast_output(coalescer.flush());
                            break;
                        }
                    }
                };
                match msg {
                    OutputMsg::Output(data) => {
                        coalescer.push(data);
                        if coalescer.pending_len() >= OUTPUT_COALESCE_MAX_BYTES {
                            session.broadcast_output(coalescer.flush());
                            last_flush = Instant::now();
                        }
                    }
                    OutputMsg::Title(title) => {
                        session.broadcast_output(coalescer.flush());
                        last_flush = Instant::now();
                        session.broadcast(&EventFrame::Title {
                            session_id: session.id.clone(),
                            title,
                        });
                    }
                    OutputMsg::Exit(code) => {
                        session.broadcast_output(coalescer.flush());
                        session.broadcast(&EventFrame::Exit {
                            session_id: session.id.clone(),
                            code,
                        });
                        session.exited.store(true, Ordering::Release);
                        if let Ok(mut handler) = session.on_exit.lock() {
                            if let Some(handler) = handler.take() {
                                handler(&session);
                            }
                        }
                        break;
                    }
                }
            }
        });
    }

    /// Broadcasts coalesced output as a single [`EventFrame::Output`], or does
    /// nothing when there was no buffered output to flush.
    fn broadcast_output(&self, data: Option<Vec<u8>>) {
        if let Some(data) = data {
            self.broadcast(&EventFrame::Output {
                session_id: self.id.clone(),
                data,
            });
        }
    }

    fn broadcast(&self, event: &EventFrame) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.push(event.clone());
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            let disconnected = fan_out(&mut subscribers, event);
            if disconnected > 0 {
                eprintln!(
                    "session {} disconnected {disconnected} stalled output subscriber(s)",
                    self.id
                );
            }
        }
    }
}

/// Sends without waiting. A full subscriber has already missed the live stream,
/// so keeping it would either lose bytes silently or apply unbounded backpressure.
/// Disconnecting makes reattach + bounded scrollback the sole recovery path.
fn fan_out(subscribers: &mut Vec<SyncSender<EventFrame>>, event: &EventFrame) -> usize {
    let before = subscribers.len();
    subscribers.retain(|tx| match tx.try_send(event.clone()) {
        Ok(()) => true,
        Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
    });
    before - subscribers.len()
}

fn instant_before_coalesce_window() -> Instant {
    Instant::now()
        .checked_sub(OUTPUT_COALESCE_INTERVAL)
        .unwrap_or_else(Instant::now)
}

/// One chunk produced by [`OscParser`]. `Output` is raw terminal output bytes
/// (with any OSC 0/2 sequences already stripped out); `Title` is the extracted
/// tab title for the frontend to apply (or ignore if the user has manually
/// renamed the tab).
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
    /// OSC 0/2 sequence or normal text. Never exceeds
    /// [`OSC_PENDING_MAX_BYTES`].
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
        let mut text_buf = Vec::with_capacity(bytes.len());
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
                        // Keep ordinary ANSI sequences in this read's output
                        // buffer. Full-screen TUIs emit an escape every few
                        // bytes; splitting each one into its own channel
                        // message makes redraw throughput allocation-bound.
                        self.replay_candidate(&mut text_buf, Some(byte));
                    }
                }
                OscState::Osc => {
                    if byte == b'0' || byte == b'2' {
                        self.pending.push(byte);
                        self.osc_number = byte - b'0';
                        self.state = OscState::OscNumber;
                    } else {
                        // Not OSC 0/2 — preserve it in the same output chunk
                        // for xterm to handle.
                        self.replay_candidate(&mut text_buf, Some(byte));
                    }
                }
                OscState::OscNumber => {
                    if byte == b';' {
                        self.pending.push(byte);
                        self.body.clear();
                        self.state = OscState::OscBody;
                    } else if byte.is_ascii_digit() {
                        // Only exact OSC 0 and 2 are title candidates. Replay
                        // a longer number immediately instead of retaining an
                        // attacker-controlled run of digits.
                        self.replay_candidate(&mut text_buf, Some(byte));
                    } else {
                        // Malformed — flush the held `ESC ] N <byte>` to the
                        // output stream and resume.
                        self.replay_candidate(&mut text_buf, Some(byte));
                    }
                }
                OscState::OscBody => {
                    if byte == 0x07 {
                        // BEL terminator — emit the title (only OSC 0/2;
                        // other numbers were filtered out above).
                        if matches!(self.osc_number, 0 | 2) {
                            let title = String::from_utf8_lossy(&self.body).into_owned();
                            if !text_buf.is_empty() {
                                out.push(OscChunk::Output(std::mem::take(&mut text_buf)));
                            }
                            out.push(OscChunk::Title(title));
                        }
                        self.reset();
                    } else if byte == 0x1B {
                        // Possible start of the ST (`ESC \`) terminator. Hold
                        // the `ESC` and wait for its companion.
                        self.state = OscState::OscSt;
                    } else if self.body.len() == OSC_TITLE_MAX_BYTES {
                        // Candidate exceeded the title budget. Replay every
                        // retained byte plus the byte that crossed the cap.
                        self.replay_candidate(&mut text_buf, Some(byte));
                    } else {
                        self.body.push(byte);
                    }
                }
                OscState::OscSt => {
                    if byte == b'\\' {
                        // ST terminator — emit the title.
                        if matches!(self.osc_number, 0 | 2) {
                            let title = String::from_utf8_lossy(&self.body).into_owned();
                            if !text_buf.is_empty() {
                                out.push(OscChunk::Output(std::mem::take(&mut text_buf)));
                            }
                            out.push(OscChunk::Title(title));
                        }
                        self.reset();
                    } else {
                        // The `ESC` was actually a body byte (some shells
                        // allow embedded escapes inside OSC bodies). Roll
                        // it into the body, switch back to OscBody, and
                        // re-process this same byte as body content.
                        if self.body.len() == OSC_TITLE_MAX_BYTES {
                            self.replay_candidate(&mut text_buf, None);
                        } else {
                            self.body.push(0x1B);
                            self.state = OscState::OscBody;
                        }
                        continue;
                    }
                }
            }
            i += 1;
        }
        if !text_buf.is_empty() {
            out.push(OscChunk::Output(text_buf));
        }
        debug_assert!(self.pending.len() <= OSC_PENDING_MAX_BYTES);
        debug_assert!(self.body.len() <= OSC_TITLE_MAX_BYTES);
        out
    }

    /// Drains any incomplete candidate at end of stream as ordinary output.
    /// No terminal bytes disappear merely because an OSC title was malformed.
    pub fn finish(&mut self) -> Vec<OscChunk> {
        if self.state == OscState::Ground {
            Vec::new()
        } else {
            let mut candidate = Vec::with_capacity(self.pending.len() + self.body.len() + 1);
            self.replay_candidate(&mut candidate, None);
            vec![OscChunk::Output(candidate)]
        }
    }

    /// Replays every retained candidate byte into the current output chunk and
    /// returns to ground state.
    fn replay_candidate(&mut self, output: &mut Vec<u8>, next: Option<u8>) {
        let trailing_esc = self.state == OscState::OscSt;
        output.append(&mut self.pending);
        output.append(&mut self.body);
        if trailing_esc {
            output.push(0x1B);
        }
        if let Some(byte) = next {
            output.push(byte);
        }
        self.state = OscState::Ground;
        self.osc_number = 0;
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
    max_bytes: usize,
    /// Total bytes of `Output` frame data currently buffered — kept in sync
    /// with `frames` so eviction never has to rescan the deque.
    output_bytes: usize,
    /// Absolute terminal output bytes observed over session lifetime.
    total_output_bytes: u64,
    frames: VecDeque<EventFrame>,
}

impl Scrollback {
    pub fn new(limit: usize) -> Self {
        Self::with_max_bytes(limit, SCROLLBACK_MAX_BYTES)
    }

    fn with_max_bytes(limit: usize, max_bytes: usize) -> Self {
        Self {
            limit,
            max_bytes,
            output_bytes: 0,
            total_output_bytes: 0,
            frames: VecDeque::new(),
        }
    }

    pub fn push(&mut self, frame: EventFrame) {
        let output_bytes = frame_output_bytes(&frame);
        self.output_bytes += output_bytes;
        self.total_output_bytes = self
            .total_output_bytes
            .saturating_add(u64::try_from(output_bytes).unwrap_or(u64::MAX));
        self.frames.push_back(frame);
        // Evict from the front until both budgets hold, but never evict the
        // frame that was just pushed — a single oversized frame stays until
        // the next push rotates it out.
        while self.frames.len() > 1
            && (self.frames.len() > self.limit || self.output_bytes > self.max_bytes)
        {
            if let Some(evicted) = self.frames.pop_front() {
                self.output_bytes = self
                    .output_bytes
                    .saturating_sub(frame_output_bytes(&evicted));
            }
        }
    }

    #[cfg(test)]
    pub fn frames(&self) -> Vec<EventFrame> {
        self.frames.iter().cloned().collect()
    }

    /// Returns retained terminal events after `cursor`, prefixed by actual
    /// replay start. Valid reconnect cursors produce only missing bytes; stale
    /// cursors rebuild from oldest retained output.
    pub fn frames_since(&self, session_id: &str, cursor: Option<u64>) -> Vec<EventFrame> {
        let retained_bytes = u64::try_from(self.output_bytes).unwrap_or(u64::MAX);
        let retained_start = self.total_output_bytes.saturating_sub(retained_bytes);
        let can_resume =
            cursor.is_some_and(|value| value >= retained_start && value <= self.total_output_bytes);
        let replay_cursor = if can_resume {
            cursor.unwrap_or(retained_start)
        } else {
            retained_start
        };
        let mut replay = vec![EventFrame::Replay {
            session_id: session_id.to_string(),
            cursor: replay_cursor,
            reset: cursor.is_some() && !can_resume,
        }];
        let mut position = retained_start;
        for frame in &self.frames {
            if let EventFrame::Output { session_id, data } = frame {
                let data_len = u64::try_from(data.len()).unwrap_or(u64::MAX);
                let end = position.saturating_add(data_len);
                if end > replay_cursor {
                    let skip = usize::try_from(replay_cursor.saturating_sub(position))
                        .unwrap_or(data.len())
                        .min(data.len());
                    replay.push(EventFrame::Output {
                        session_id: session_id.clone(),
                        data: data[skip..].to_vec(),
                    });
                }
                position = end;
            } else if position >= replay_cursor {
                replay.push(frame.clone());
            }
        }
        replay
    }

    /// True when the buffered `Output` frame data contains `needle`, including
    /// occurrences split across adjacent frames.
    pub fn output_contains(&self, needle: &[u8]) -> bool {
        if needle.is_empty() {
            return true;
        }
        let overlap = needle.len() - 1;
        // Tail of the previously scanned output, kept so a needle split across
        // a frame boundary is still found.
        let mut tail: Vec<u8> = Vec::new();
        for frame in &self.frames {
            let EventFrame::Output { data, .. } = frame else {
                continue;
            };
            if !tail.is_empty() {
                let mut boundary = tail.clone();
                boundary.extend_from_slice(&data[..data.len().min(overlap)]);
                if contains(&boundary, needle) {
                    return true;
                }
            }
            if contains(data, needle) {
                return true;
            }
            if data.len() >= overlap {
                tail = data[data.len() - overlap..].to_vec();
            } else {
                tail.extend_from_slice(data);
                let excess = tail.len().saturating_sub(overlap);
                tail.drain(..excess);
            }
        }
        false
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Bytes of terminal output a frame pins in memory. Non-output frames (title,
/// exit, agent, …) are small and already bounded by the frame-count limit.
fn frame_output_bytes(frame: &EventFrame) -> usize {
    match frame {
        EventFrame::Output { data, .. } => data.len(),
        _ => 0,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayDiscovery {
    port: u16,
    token: String,
    protocol_version: u64,
}

struct GatewayEnv {
    url: String,
    token: String,
}

fn gateway_env(server_socket: &str) -> Option<GatewayEnv> {
    let discovery_path =
        Path::new(server_socket).with_file_name(CONSTANTS.gateway.discovery_file.as_str());
    let discovery: GatewayDiscovery =
        serde_json::from_str(&std::fs::read_to_string(discovery_path).ok()?).ok()?;
    if discovery.protocol_version != CONSTANTS.daemon.protocol_version.get()
        || discovery.token.is_empty()
    {
        return None;
    }
    Some(GatewayEnv {
        url: format!("http://127.0.0.1:{}", discovery.port),
        token: discovery.token,
    })
}

/// Reads a project's configured shell from its `.pragma/config.json`.
///
/// Returns `None` when the file is absent, unreadable, or names no shell —
/// every one of which means "use the platform default" rather than an error, so
/// a malformed config never stops a terminal from opening.
fn project_shell(cwd: &str) -> Option<String> {
    let path = Path::new(cwd).join(&CONSTANTS.plugins.config_file_name);
    let contents = std::fs::read_to_string(path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&contents).ok()?;
    config
        .get("terminal")?
        .get("shell")?
        .as_str()
        .map(str::trim)
        .filter(|shell| !shell.is_empty())
        .map(str::to_string)
}

fn pragma_cli_path() -> Option<PathBuf> {
    let channel = std::env::var_os("PRAGMA_SERVER_CHANNEL");
    pragma_cli_path_from(
        channel.as_deref(),
        std::env::var_os("PRAGMA_APP_DATA_DIR"),
        std::env::var_os("HOME"),
    )
}

fn pragma_cli_path_from(
    channel: Option<&std::ffi::OsStr>,
    app_data_dir: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(channel) = channel.filter(|channel| *channel != "pragma") {
        return app_data_dir
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .map(|dir| dir.join(channel))
            .map(|dir| dir.join("bin/pragma-cli"));
    }
    home.filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .map(|dir| dir.join(".local/bin/pragma-cli"))
}

fn path_with_cli_dir(cli_path: &Path) -> String {
    path_with_cli_dir_from(cli_path, std::env::var_os("PATH"))
}

fn path_with_cli_dir_from(cli_path: &Path, existing: Option<std::ffi::OsString>) -> String {
    let Some(cli_dir) = cli_path.parent() else {
        return existing
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
    };
    let mut paths = vec![cli_dir.to_path_buf()];
    let fallback = existing
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(existing) = existing {
        paths.extend(std::env::split_paths(&existing).filter(|entry| entry != cli_dir));
    }
    std::env::join_paths(paths).map_or(fallback, |path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::mpsc::{self, TryRecvError, TrySendError};

    use super::{
        fan_out, gateway_env, path_with_cli_dir_from, pragma_cli_path_from, project_shell, thread,
        Duration, Instant, OscChunk, OscParser, OutputCoalescer, OutputMsg, Scrollback, Session,
        OSC_PENDING_MAX_BYTES, OSC_TITLE_MAX_BYTES, OUTPUT_CHANNEL_CAPACITY,
    };
    use pragma_constants::CONSTANTS;
    use pragma_protocol::EventFrame;

    #[test]
    fn coalescer_merges_consecutive_output() {
        let mut coalescer = OutputCoalescer::default();
        // Nothing buffered yet.
        assert_eq!(coalescer.flush(), None);
        // Consecutive pushes accumulate and flush as a single concatenated frame.
        coalescer.push(b"foo".to_vec());
        coalescer.push(b"bar".to_vec());
        assert_eq!(coalescer.pending_len(), 6);
        assert_eq!(coalescer.flush(), Some(b"foobar".to_vec()));
        // A flush drains the buffer.
        assert_eq!(coalescer.flush(), None);
    }

    #[test]
    fn reader_channel_is_bounded_and_preserves_order_after_backpressure() {
        let (tx, rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
        let capacity = u8::try_from(OUTPUT_CHANNEL_CAPACITY).expect("test capacity fits in u8");
        for byte in 0..capacity {
            tx.try_send(OutputMsg::Output(vec![byte]))
                .expect("queue has capacity");
        }
        let overflow = match tx.try_send(OutputMsg::Output(vec![capacity])) {
            Err(TrySendError::Full(msg)) => msg,
            other => panic!("expected full reader queue, got {other:?}"),
        };

        assert!(matches!(
            rx.recv().expect("first queued message"),
            OutputMsg::Output(data) if data == [0]
        ));
        tx.try_send(overflow).expect("space released by consumer");
        for byte in 1..=capacity {
            assert!(matches!(
                rx.recv().expect("queued message"),
                OutputMsg::Output(data) if data == [byte]
            ));
        }
    }

    #[test]
    fn full_subscriber_is_disconnected_without_losing_scrollback() {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut subscribers = vec![tx];
        let mut scrollback = Scrollback::new(10);
        let first = EventFrame::Output {
            session_id: "s".to_string(),
            data: b"first".to_vec(),
        };
        let second = EventFrame::Output {
            session_id: "s".to_string(),
            data: b"second".to_vec(),
        };

        scrollback.push(first.clone());
        fan_out(&mut subscribers, &first);
        scrollback.push(second);
        fan_out(
            &mut subscribers,
            scrollback.frames().last().expect("second frame"),
        );

        assert!(subscribers.is_empty(), "full subscriber must be removed");
        assert!(matches!(
            rx.recv().expect("already queued event remains readable"),
            EventFrame::Output { data, .. } if data == b"first"
        ));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Disconnected)));
        let replayed: Vec<u8> = scrollback
            .frames()
            .into_iter()
            .filter_map(|frame| match frame {
                EventFrame::Output { data, .. } => Some(data),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(replayed, b"firstsecond");
    }

    /// Spawns a real shell on a real PTY and drives it until `needle` appears.
    ///
    /// This is the one test that proves the launch actually works end to end:
    /// the resolved program, its interactive arguments, and the platform's
    /// pseudo-terminal (a pty on Unix, `ConPTY` on Windows). A wrong argument —
    /// handing PowerShell the POSIX `-l`, say — makes the shell exit instead of
    /// echoing, and shows up here rather than as a terminal that opens blank.
    fn spawn_and_expect(command: &str, needle: &[u8]) {
        let dir = tempfile::tempdir().expect("tempdir");
        let session = Session::spawn_with_exit_handler(
            "test-tab".to_string(),
            "test-worktree".to_string(),
            dir.path().to_string_lossy().into_owned(),
            80,
            24,
            "unused-socket",
            |_| {},
        )
        .expect("a shell spawns on a pseudo-terminal");

        session.write(command).expect("the shell accepts input");

        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if session.output_contains(needle) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "the shell never echoed {:?} within the timeout",
            String::from_utf8_lossy(needle)
        );
    }

    /// Guarded by `PRAGMA_TEST_PTY` because a sandboxed or headless CI executor
    /// may not be allowed to allocate a pseudo-terminal, and a spawn failure
    /// there would be an environment artefact rather than a real regression.
    #[test]
    fn a_real_shell_echoes_through_a_real_pty() {
        if std::env::var_os("PRAGMA_TEST_PTY").is_none() {
            return;
        }
        let marker = "pragma-pty-marker";
        // `echo` exists in every shell this resolves to, PowerShell included.
        spawn_and_expect(&format!("echo {marker}\r"), marker.as_bytes());
    }

    /// Regression test for the resource leak this session's `kill` fixes:
    /// `portable_pty`'s own `Child::kill` only signals the shell's own pid, so
    /// anything the shell backgrounded (a dev server, a disowned job) used to
    /// survive the session being killed and pile up as orphaned processes.
    /// Backgrounds a `sleep` under the session's shell, kills the session, and
    /// asserts the backgrounded process is gone too — not just the shell.
    ///
    /// Unix-only because the setup uses POSIX shell syntax (`&`, `$!`) the
    /// platform default shell resolves to on Unix but not on Windows
    /// (PowerShell); the mechanism under test itself
    /// ([`process::kill_process_tree`]) is cross-platform.
    #[test]
    #[cfg(unix)]
    fn kill_terminates_the_whole_process_group_not_just_the_shell() {
        if std::env::var_os("PRAGMA_TEST_PTY").is_none() {
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let session = Session::spawn_with_exit_handler(
            "test-tab-group-kill".to_string(),
            "test-worktree".to_string(),
            dir.path().to_string_lossy().into_owned(),
            80,
            24,
            "unused-socket",
            |_| {},
        )
        .expect("a shell spawns on a pseudo-terminal");

        let marker_file = dir.path().join("child.pid");
        session
            .write(&format!("sleep 60 & echo $! > {}\r", marker_file.display()))
            .expect("the shell accepts input");

        let deadline = Instant::now() + Duration::from_secs(20);
        let child_pid: u32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&marker_file) {
                if let Ok(pid) = contents.trim().parse() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "backgrounded child pid was never written"
            );
            thread::sleep(Duration::from_millis(50));
        };
        assert!(
            process_is_alive(child_pid),
            "backgrounded child should be running before kill"
        );

        session.kill().expect("kill succeeds");

        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(child_pid) {
            assert!(
                Instant::now() < deadline,
                "backgrounded child survived session kill"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        // Captured rather than inherited: a dead pid is the expected steady
        // state once the poll loop above succeeds, and `kill -0` writes
        // "No such process" to stderr on every such check.
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .is_ok_and(|output| output.status.success())
    }

    /// Writes a project config declaring `shell` and returns its worktree root.
    fn project_with_shell(dir: &std::path::Path, shell: &str) -> String {
        let config = dir.join(&CONSTANTS.plugins.config_file_name);
        std::fs::create_dir_all(config.parent().expect("config parent")).expect("config dir");
        std::fs::write(&config, format!(r#"{{"terminal":{{"shell":"{shell}"}}}}"#))
            .expect("write config");
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn a_project_can_choose_its_own_shell() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = project_with_shell(dir.path(), "/usr/bin/fish");
        assert_eq!(project_shell(&cwd).as_deref(), Some("/usr/bin/fish"));
    }

    #[test]
    fn a_project_without_a_config_uses_the_platform_default() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(project_shell(&dir.path().to_string_lossy()), None);
    }

    /// A broken config must not stop a terminal from opening — falling back to
    /// the platform default is strictly better than refusing to launch a shell.
    #[test]
    fn a_malformed_project_config_falls_back_rather_than_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = dir.path().join(&CONSTANTS.plugins.config_file_name);
        std::fs::create_dir_all(config.parent().expect("config parent")).expect("config dir");
        std::fs::write(&config, "{ not json").expect("write config");
        assert_eq!(project_shell(&dir.path().to_string_lossy()), None);
    }

    #[test]
    fn a_blank_configured_shell_is_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = project_with_shell(dir.path(), "   ");
        assert_eq!(project_shell(&cwd), None);
    }

    #[test]
    fn gateway_env_reads_discovery_beside_socket() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("daemon.sock");
        std::fs::write(
            socket.with_file_name(CONSTANTS.gateway.discovery_file.as_str()),
            format!(
                r#"{{"port":4567,"token":"secret","pid":123,"protocolVersion":{}}}"#,
                CONSTANTS.daemon.protocol_version.get()
            ),
        )
        .expect("write discovery");

        let env = gateway_env(&socket.to_string_lossy()).expect("gateway env");

        assert_eq!(env.url, "http://127.0.0.1:4567");
        assert_eq!(env.token, "secret");
    }

    #[test]
    fn gateway_env_rejects_stale_protocol() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("daemon.sock");
        std::fs::write(
            socket.with_file_name(CONSTANTS.gateway.discovery_file.as_str()),
            r#"{"port":4567,"token":"secret","pid":123,"protocolVersion":0}"#,
        )
        .expect("write discovery");

        assert!(gateway_env(&socket.to_string_lossy()).is_none());
    }

    #[test]
    fn scrollback_is_bounded() {
        let mut scrollback = Scrollback::new(2);
        for data in ["one", "two", "three"] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data: data.as_bytes().to_vec(),
            });
        }
        assert_eq!(scrollback.frames().len(), 2);
    }

    /// Regression test for unbounded scrollback memory: the frame-count cap
    /// alone let coalesced output frames (up to 256 KiB each) pin gigabytes
    /// per long-lived session. The byte budget must evict old output even
    /// when the frame count is nowhere near its limit.
    #[test]
    fn scrollback_is_bounded_by_bytes() {
        let mut scrollback = Scrollback::with_max_bytes(100, 10);
        for data in [b"aaaa".to_vec(), b"bbbb".to_vec(), b"cccc".to_vec()] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data,
            });
        }
        // 12 bytes pushed against a 10-byte budget: the oldest frame is gone.
        let frames = scrollback.frames();
        assert_eq!(frames.len(), 2);
        assert!(matches!(
            &frames[0],
            EventFrame::Output { data, .. } if data == b"bbbb"
        ));
    }

    #[test]
    fn scrollback_resumes_from_an_absolute_output_cursor() {
        let mut scrollback = Scrollback::with_max_bytes(100, 100);
        for data in [b"abcd".to_vec(), b"efgh".to_vec()] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data,
            });
        }

        let replay = scrollback.frames_since("s", Some(3));

        assert!(matches!(
            replay.first(),
            Some(EventFrame::Replay {
                cursor: 3,
                reset: false,
                ..
            })
        ));
        let output = replay
            .into_iter()
            .filter_map(|frame| match frame {
                EventFrame::Output { data, .. } => Some(data),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(output, b"defgh");
    }

    #[test]
    fn stale_output_cursor_requests_one_bounded_reset() {
        let mut scrollback = Scrollback::with_max_bytes(100, 4);
        for data in [b"abcd".to_vec(), b"efgh".to_vec()] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data,
            });
        }

        let replay = scrollback.frames_since("s", Some(2));

        assert!(matches!(
            replay.first(),
            Some(EventFrame::Replay {
                cursor: 4,
                reset: true,
                ..
            })
        ));
        assert!(matches!(
            replay.get(1),
            Some(EventFrame::Output { data, .. }) if data == b"efgh"
        ));
    }

    /// The alternate-screen readiness scan must find a sequence even when the
    /// PTY reader split it across two output frames.
    #[test]
    fn scrollback_output_contains_spans_frame_boundaries() {
        let mut scrollback = Scrollback::new(10);
        for data in [b"boot \x1b[?10".to_vec(), b"49h draw".to_vec()] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data,
            });
        }
        scrollback.push(EventFrame::Title {
            session_id: "s".to_string(),
            title: "\x1b[?1047h".to_string(),
        });
        assert!(scrollback.output_contains(b"\x1b[?1049h"));
        assert!(scrollback.output_contains(b"boot"));
        // Non-output frames never satisfy the scan.
        assert!(!scrollback.output_contains(b"\x1b[?1047h"));
        assert!(!scrollback.output_contains(b"missing"));
    }

    /// Non-output frames must not be starved out by the byte budget, and a
    /// single frame larger than the whole budget must still be kept until the
    /// next push (never evict the frame just pushed).
    #[test]
    fn scrollback_byte_budget_keeps_control_frames_and_oversized_frames() {
        let mut scrollback = Scrollback::with_max_bytes(100, 10);
        scrollback.push(EventFrame::Output {
            session_id: "s".to_string(),
            data: vec![0_u8; 64],
        });
        assert_eq!(scrollback.frames().len(), 1, "oversized frame is kept");
        scrollback.push(EventFrame::Title {
            session_id: "s".to_string(),
            title: "t".to_string(),
        });
        let frames = scrollback.frames();
        assert_eq!(frames.len(), 1, "oversized output rotates out");
        assert!(matches!(&frames[0], EventFrame::Title { .. }));
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
    fn extracts_title_at_body_cap() {
        let title = vec![b'x'; OSC_TITLE_MAX_BYTES];
        let mut input = b"\x1b]0;".to_vec();
        input.extend_from_slice(&title);
        input.push(0x07);

        let (outputs, titles) = split(feed(&input));

        assert!(outputs.is_empty());
        assert_eq!(titles, vec![String::from_utf8(title).expect("ASCII title")]);
    }

    #[test]
    fn oversized_title_is_replayed_as_ordinary_output() {
        let mut input = b"before\x1b]2;".to_vec();
        input.extend(std::iter::repeat_n(b'x', OSC_TITLE_MAX_BYTES + 1));
        input.extend_from_slice(b"\x07after");
        let mut parser = OscParser::default();

        let (outputs, titles) = split(parser.push(&input));
        let output: Vec<u8> = outputs.into_iter().flatten().collect();

        assert_eq!(output, input);
        assert!(titles.is_empty());
        assert!(parser.pending.len() <= OSC_PENDING_MAX_BYTES);
        assert!(parser.body.len() <= OSC_TITLE_MAX_BYTES);
    }

    #[test]
    fn unterminated_title_is_replayed_on_finish() {
        let input = b"\x1b]0;unfinished\x1b";
        let mut parser = OscParser::default();
        let mut chunks = parser.push(input);
        chunks.extend(parser.finish());
        let (outputs, titles) = split(chunks);

        assert_eq!(outputs.into_iter().flatten().collect::<Vec<_>>(), input);
        assert!(titles.is_empty());
    }

    #[test]
    fn oversized_osc_number_never_grows_pending_or_loses_bytes() {
        let mut input = b"\x1b]".to_vec();
        input.extend(std::iter::repeat_n(b'0', OSC_PENDING_MAX_BYTES * 1024));
        input.extend_from_slice(b";not-a-title\x07");
        let mut parser = OscParser::default();
        let mut chunks = Vec::new();

        for byte in &input {
            chunks.extend(parser.push(std::slice::from_ref(byte)));
            assert!(parser.pending.len() <= OSC_PENDING_MAX_BYTES);
            assert!(parser.body.len() <= OSC_TITLE_MAX_BYTES);
        }
        chunks.extend(parser.finish());
        let (outputs, titles) = split(chunks);

        assert_eq!(outputs.into_iter().flatten().collect::<Vec<_>>(), input);
        assert!(titles.is_empty());
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
        let input = b"\x1b[2J\x1b[31mred\x1b[0m\x1b[Hprompt$ ";
        let chunks = feed(input);
        let (outputs, titles) = split(chunks);
        assert_eq!(outputs, vec![input.to_vec()]);
        assert!(titles.is_empty());
    }

    #[test]
    fn only_titles_split_escape_heavy_output() {
        let chunks = feed(b"before\x1b[31mred\x1b]0;title\x07\x1b[0mafter");

        assert_eq!(
            chunks,
            vec![
                OscChunk::Output(b"before\x1b[31mred".to_vec()),
                OscChunk::Title("title".to_string()),
                OscChunk::Output(b"\x1b[0mafter".to_vec()),
            ]
        );
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

    #[test]
    fn cli_dir_is_prepended_to_path_once() {
        // Build both the fixture and the expectation with `join_paths` rather than
        // a literal `:`-joined string. PATH is `;`-separated on Windows, so a
        // hardcoded POSIX list arrives as one opaque entry there: the dedup below
        // silently finds nothing to drop and the assertion fails for the wrong
        // reason. `path_with_cli_dir_from` itself uses split_paths/join_paths.
        let cli_dir = Path::new("/Users/test/.local/bin");
        let existing = std::env::join_paths([Path::new("/usr/bin"), cli_dir, Path::new("/bin")])
            .expect("join existing");
        let expected = std::env::join_paths([cli_dir, Path::new("/usr/bin"), Path::new("/bin")])
            .expect("join expected");

        let path = path_with_cli_dir_from(&cli_dir.join("pragma-cli"), Some(existing));

        assert_eq!(path, expected.to_string_lossy());
    }

    #[test]
    fn cli_path_is_global_for_prod_and_instance_scoped_for_dev() {
        assert_eq!(
            pragma_cli_path_from(
                Some(std::ffi::OsStr::new("pragma")),
                Some("/data/prod".into()),
                Some("/home/test".into()),
            ),
            Some(Path::new("/home/test/.local/bin/pragma-cli").to_path_buf())
        );
        assert_eq!(
            pragma_cli_path_from(
                Some(std::ffi::OsStr::new("pragma-dev-abc")),
                Some("/data".into()),
                Some("/home/test".into()),
            ),
            Some(Path::new("/data/pragma-dev-abc/bin/pragma-cli").to_path_buf())
        );
    }
}
