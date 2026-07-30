//! Server and session lifecycle for the T1 tier.
//!
//! T1 measures the transport the desktop app actually uses, so it drives a real
//! `pragma-server` process over a real local socket through the real
//! [`PragmaClient`] — including that client's queued writer thread, which is
//! itself part of keystroke latency. Nothing here reimplements a hop.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use pragma_client::{executable_name, PragmaClient};
use pragma_platform::ipc::{self, LocalStream};
use pragma_protocol::{read_frame, Frame};

/// Emitted by `pragma-bench-load` once it has taken the terminal and is ready to
/// be measured. Chosen from control bytes no corpus contains, so a scenario can
/// never mistake payload output for the readiness signal.
pub const READY_MARKER: &[u8] = b"\x01PRAGMA_BENCH_READY\x01";

/// Written by the `tui` payload after each complete frame.
///
/// Without it the benchmark would have to know a frame's exact byte length to
/// know when a redraw finished, which would mean duplicating the payload's
/// rendering logic in the measurement — and silently mismeasuring the moment
/// either copy changed.
pub const FRAME_MARKER: &[u8] = b"\x02";

/// Ceiling on any single blocking read from a session's event stream. A wedged
/// server must fail the run with an explanation rather than hang CI until the
/// job's own timeout kills it with no output.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on how long a payload may take to reach [`READY_MARKER`]. Generous
/// because it includes a real shell start-up on a cold, loaded CI runner.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on how long the server may take to bind its socket.
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum BenchError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("client: {0}")]
    Client(#[from] pragma_client::ClientError),
    #[error("protocol: {0}")]
    Protocol(#[from] pragma_protocol::ProtocolError),
    #[error("timed out after {waited:?} waiting for {what}")]
    Timeout { what: String, waited: Duration },
    #[error("{0}")]
    Setup(String),
}

pub type BenchResult<T> = Result<T, BenchError>;

/// A `pragma-server` process owned by the benchmark, with its own socket and
/// data directory, torn down on drop.
pub struct BenchServer {
    child: Child,
    root: PathBuf,
    client: PragmaClient,
}

impl BenchServer {
    /// Starts a server whose state is isolated from the developer's real one.
    ///
    /// `server_bin` is the `pragma-server` executable to run. The socket path is
    /// deliberately rooted at a short directory: a Unix-domain address is capped
    /// at [`ipc::MAX_SOCKET_PATH_BYTES`] (107) bytes, and macOS's per-user
    /// `TMPDIR` (`/var/folders/…`) is long enough that the default temp
    /// directory plus a channel plus a socket name overruns it.
    pub fn start(server_bin: &Path) -> BenchResult<Self> {
        let root = short_scratch_dir()?;
        let channel = "bench";
        let server_dir = root.join(channel);
        std::fs::create_dir_all(&server_dir)?;
        let socket = ipc::socket_path_in(&server_dir);
        ipc::check_socket_path(&socket).map_err(|error| {
            BenchError::Setup(format!(
                "benchmark socket path is unusable ({error}); \
                 set TMPDIR to something short and retry"
            ))
        })?;

        let mut command = pragma_platform::process::command(server_bin);
        command
            .env("PRAGMA_APP_DATA_DIR", &root)
            .env("PRAGMA_SERVER_CHANNEL", channel)
            // On Linux the server prefers XDG_RUNTIME_DIR over
            // PRAGMA_APP_DATA_DIR, so it has to be redirected too or the
            // benchmark would attach to the developer's real server.
            .env("XDG_RUNTIME_DIR", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn()?;

        let started = Instant::now();
        while started.elapsed() < SERVER_START_TIMEOUT {
            if socket.exists() && ipc::connect(&socket).is_ok() {
                let client = PragmaClient::new_socket(socket);
                return Ok(Self {
                    child,
                    root,
                    client,
                });
            }
            thread::sleep(Duration::from_millis(20));
        }
        Err(BenchError::Timeout {
            what: format!("pragma-server to bind {}", socket.display()),
            waited: started.elapsed(),
        })
    }

    /// The client every scenario drives the server through.
    #[must_use]
    pub fn client(&self) -> &PragmaClient {
        &self.client
    }

    /// A directory sessions may use as their working directory.
    #[must_use]
    pub fn scratch(&self) -> &Path {
        &self.root
    }
}

impl Drop for BenchServer {
    fn drop(&mut self) {
        // Kill rather than ask politely: the server is designed to outlive its
        // client, so a graceful shutdown request would leave it running and the
        // next benchmark run would find a stale socket for this channel.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Output observed but not yet consumed by a `read_until` caller.
///
/// A frame can carry far more than the marker being waited on, so the remainder
/// has to be retained or every later read desynchronises — while the buffer
/// still has to stay bounded, because a firehose delivers megabytes.
#[derive(Debug, Default)]
struct OutputBuffer(Vec<u8>);

impl OutputBuffer {
    fn extend(&mut self, data: &[u8]) {
        self.0.extend_from_slice(data);
    }

    fn len(&self) -> usize {
        self.0.len()
    }

    fn clear(&mut self) {
        self.0.clear();
    }

    /// Consumes buffered output up to and including `needle`, if it is present.
    fn take_through(&mut self, needle: &[u8]) -> bool {
        let Some(at) = find(&self.0, needle) else {
            return false;
        };
        self.0.drain(..at + needle.len());
        true
    }

    /// Bounds retained output.
    ///
    /// Only ever called after the needle was searched for and *not* found, so
    /// every discarded byte has already been examined. The retained tail is kept
    /// comfortably longer than the needle so one straddling the next frame
    /// boundary still matches. Trimming before searching would be a bug: a
    /// payload that announces itself and then immediately floods gets its marker
    /// and a great deal of output coalesced into a single frame.
    fn trim(&mut self, needle_len: usize) {
        let cap = needle_len.max(64) * 4;
        if self.0.len() > cap {
            let excess = self.0.len() - cap;
            self.0.drain(..excess);
        }
    }
}

/// A live PTY session plus its event stream.
pub struct BenchSession {
    id: String,
    stream: LocalStream,
    client: PragmaClient,
    pending: OutputBuffer,
}

impl BenchSession {
    /// Spawns a session and runs `payload` in it, returning once the payload has
    /// announced [`READY_MARKER`].
    ///
    /// `payload` is executed with `exec` so the shell replaces itself: after
    /// this returns, no shell sits between the benchmark and the program under
    /// measurement, and shell start-up cost is excluded from every sample.
    /// `stty raw -echo` first, so the kernel line discipline neither buffers
    /// input until a newline nor adds an echo the payload did not produce.
    pub fn start(server: &BenchServer, payload: &str, cols: u16, rows: u16) -> BenchResult<Self> {
        let id = format!("bench-{}", uuid::Uuid::new_v4());
        let cwd = server.scratch().to_string_lossy().to_string();
        let stream = server.client().spawn_stream(
            id.clone(),
            "bench-worktree".to_string(),
            cwd,
            cols,
            rows,
        )?;
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let mut session = Self {
            id,
            stream,
            client: server.client().clone(),
            pending: OutputBuffer::default(),
        };
        session.send(format!("stty raw -echo; exec {payload}\n").as_bytes())?;
        session.read_until(READY_MARKER, READY_TIMEOUT)?;
        Ok(session)
    }

    /// This session's id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Sends input the way the desktop app does — through the client's queued
    /// writer connection, so its enqueue cost is inside every measurement.
    pub fn send(&self, data: &[u8]) -> BenchResult<()> {
        self.client.write(self.id.clone(), data.to_vec())?;
        Ok(())
    }

    /// Reads output frames until `needle` has been observed, returning how many
    /// [`Frame::Output`] frames it took.
    ///
    /// The frame count is a first-class result, not a diagnostic: it is how the
    /// audit detects a change in the server's output coalescing, which is a
    /// structural regression no wall-clock measurement would reliably catch.
    pub fn read_until(&mut self, needle: &[u8], timeout: Duration) -> BenchResult<usize> {
        let started = Instant::now();
        let mut frames = 0;
        if self.take_through(needle) {
            return Ok(frames);
        }
        loop {
            if started.elapsed() > timeout {
                return Err(BenchError::Timeout {
                    what: format!(
                        "{:?} on session {}",
                        String::from_utf8_lossy(needle),
                        self.id
                    ),
                    waited: started.elapsed(),
                });
            }
            match read_frame(&mut self.stream)? {
                Frame::Output { data, .. } => {
                    frames += 1;
                    self.pending.extend(&data);
                    // Search before trimming, always. A payload that announces
                    // itself and then immediately floods (the `noise` mode) gets
                    // its marker and a great deal of corpus coalesced into one
                    // frame; trimming first would discard the marker along with
                    // the corpus and the wait would never end.
                    if self.take_through(needle) {
                        return Ok(frames);
                    }
                    self.trim_pending(needle.len());
                }
                // `Input` only ever travels client-to-server; a server that sent
                // one would be a protocol violation, not something to measure.
                Frame::Json(_) | Frame::Input { .. } => {}
            }
        }
    }

    fn take_through(&mut self, needle: &[u8]) -> bool {
        self.pending.take_through(needle)
    }

    fn trim_pending(&mut self, needle_len: usize) {
        self.pending.trim(needle_len);
    }

    /// Reads output frames until `total` bytes of payload have arrived,
    /// returning `(frames, bytes)`.
    pub fn read_bytes(&mut self, total: usize, timeout: Duration) -> BenchResult<(usize, usize)> {
        let started = Instant::now();
        let mut frames = 0;
        let mut bytes = self.pending.len();
        self.pending.clear();
        while bytes < total {
            if started.elapsed() > timeout {
                return Err(BenchError::Timeout {
                    what: format!("{total} bytes on session {} (got {bytes})", self.id),
                    waited: started.elapsed(),
                });
            }
            if let Frame::Output { data, .. } = read_frame(&mut self.stream)? {
                frames += 1;
                bytes += data.len();
            }
        }
        Ok((frames, bytes))
    }

    /// Drains this session's stream on a background thread until `stop` is set.
    ///
    /// Background sessions in the tab-scaling scenario *must* be drained: the
    /// server drops output to a subscriber whose channel is full, which would
    /// both distort the load and mask the drop as if the session were quiet.
    #[must_use]
    pub fn drain_in_background(self, stop: &Arc<AtomicBool>) -> thread::JoinHandle<u64> {
        let stop = Arc::clone(stop);
        thread::spawn(move || {
            let mut session = self;
            let mut resets = 0;
            while !stop.load(Ordering::Relaxed) {
                match read_frame(&mut session.stream) {
                    Ok(Frame::Json(bytes)) => {
                        // A `reset` replay frame is the server telling us its
                        // retained scrollback could not cover the gap — hard
                        // evidence that output was dropped under load.
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            if text.contains("\"reset\":true") {
                                resets += 1;
                            }
                        }
                    }
                    Ok(Frame::Output { .. } | Frame::Input { .. }) => {}
                    Err(_) => break,
                }
            }
            resets
        })
    }

    /// Kills the underlying PTY.
    pub fn kill(&self) -> BenchResult<()> {
        self.client.kill(self.id.clone())?;
        Ok(())
    }
}

/// Locates a benchmark executable next to the running one.
///
/// Both benchmark binaries are built into the same target directory, so the
/// sibling of `current_exe` is the right one without threading a path through
/// every caller. Named through [`executable_name`] so the `.exe` suffix is
/// applied on Windows rather than producing a path that silently does not exist.
pub fn sibling_executable(name: &str) -> BenchResult<PathBuf> {
    let current = std::env::current_exe()?;
    let dir = current
        .parent()
        .ok_or_else(|| BenchError::Setup("the running executable has no parent".to_string()))?;
    let candidate = dir.join(executable_name(name));
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(BenchError::Setup(format!(
        "could not find {} next to {}; build it with `cargo build -p pragma-bench`",
        candidate.display(),
        current.display()
    )))
}

/// Creates a short-pathed scratch directory.
///
/// See [`BenchServer::start`] for why the length matters.
fn short_scratch_dir() -> BenchResult<PathBuf> {
    let base = if cfg!(unix) {
        PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = base.join(format!("pb-{}", &id[..8]));
    pragma_platform::perms::create_private_dir(&dir)?;
    Ok(dir)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Writes `data` to a sink and flushes, so a payload's output is not left
/// sitting in a buffer while the benchmark waits for it.
pub fn write_now(sink: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    sink.write_all(data)?;
    sink.flush()
}

#[cfg(test)]
mod tests {
    use super::{find, short_scratch_dir, OutputBuffer, READY_MARKER};
    use pragma_platform::ipc;

    #[test]
    fn finds_a_needle_spanning_the_middle() {
        assert_eq!(find(b"abcdef", b"cd"), Some(2));
        assert_eq!(find(b"abcdef", b"abcdef"), Some(0));
        assert_eq!(find(b"abc", b"abcd"), None);
        assert_eq!(find(b"abc", b""), None);
    }

    #[test]
    fn scratch_socket_path_fits_the_address_limit() {
        // The whole reason `short_scratch_dir` exists. If this ever fails, every
        // scenario fails later with an opaque InvalidInput from the socket layer.
        let dir = short_scratch_dir().expect("scratch dir");
        let socket = ipc::socket_path_in(&dir.join("bench"));
        let result = ipc::check_socket_path(&socket);
        let _ = std::fs::remove_dir_all(&dir);
        result.expect("benchmark socket path must be addressable");
    }

    #[test]
    fn finds_a_marker_buried_in_a_flood() {
        // The `noise` payload announces itself and then immediately floods, so
        // the server coalesces the marker and a great deal of corpus into one
        // frame. Trimming the buffer before searching it discarded the marker
        // along with the corpus, and the whole tab-scaling scenario hung until
        // it timed out.
        let mut buffer = OutputBuffer::default();
        let mut frame = READY_MARKER.to_vec();
        frame.extend(std::iter::repeat_n(b'x', 64 * 1024));
        buffer.extend(&frame);
        assert!(buffer.take_through(READY_MARKER));
        assert_eq!(
            buffer.len(),
            64 * 1024,
            "output after the marker is retained"
        );
    }

    #[test]
    fn trimming_keeps_a_marker_straddling_a_frame_boundary() {
        let mut buffer = OutputBuffer::default();
        buffer.extend(&vec![b'x'; 64 * 1024]);
        assert!(!buffer.take_through(READY_MARKER));
        buffer.trim(READY_MARKER.len());
        assert!(buffer.len() < 64 * 1024, "the buffer stays bounded");
        // Deliver the marker split across the boundary the trim just created.
        let (head, tail) = READY_MARKER.split_at(4);
        buffer.extend(head);
        buffer.trim(READY_MARKER.len());
        buffer.extend(tail);
        assert!(buffer.take_through(READY_MARKER));
    }

    #[test]
    fn ready_marker_is_not_printable_text() {
        // A marker made of ordinary characters could appear inside a corpus and
        // be mistaken for the payload announcing itself.
        assert!(READY_MARKER.iter().any(|byte| *byte < 0x20));
    }
}
