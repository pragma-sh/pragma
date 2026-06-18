use std::fs::OpenOptions;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::CONSTANTS;
use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, EventFrame, Frame, RequestFrame, RequestKind,
    ServerFrame,
};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DAEMON_DETACH_FLAG: &str = "--detach";

#[derive(Clone)]
pub struct PtyClient {
    app_data_dir: PathBuf,
    /// Channel-scoped subdirectory name (`pragma` / `pragma-dev`) that isolates
    /// this build's daemon from a differently-built sibling. Chosen from the
    /// build's product identity (see `daemon_channel_for_product`) — **not** the
    /// compile profile — so a release-built dev app still never attaches to the
    /// production daemon. Passed to the spawned daemon via `PRAGMA_DAEMON_CHANNEL`
    /// so both processes resolve the identical path.
    channel: String,
    launch_lock: Arc<Mutex<()>>,
    /// Long-lived connection reused for request/response calls (resize, kill).
    /// Opening a fresh socket and replaying the protocol handshake per call would
    /// add a full connect + hello round-trip of latency, so these reuse one
    /// pooled stream. The connection only ever carries `Response` frames
    /// (request-type calls never return an event stream), so a single
    /// mutex-guarded stream safely serializes all of them.
    request_conn: Arc<Mutex<Option<UnixStream>>>,
    /// Dedicated fire-and-forget sender for keystroke input. Every keystroke is a
    /// `write`, which is the latency-critical hot path: the user must see the
    /// echo as fast as possible. Writes are *fire-and-forget* — we don't need the
    /// daemon's acknowledgement — so they get their own connection and a writer
    /// thread, kept off both the blocking-pool scheduler and the request
    /// connection. This means consecutive keystrokes pipeline instead of each one
    /// waiting for the previous keystroke's full daemon round-trip (which, on the
    /// shared request connection, serialized typing behind a response read).
    input_tx: Arc<Mutex<Option<Sender<InputMsg>>>>,
}

/// A single queued keystroke payload for the dedicated input writer thread.
struct InputMsg {
    session_id: String,
    data: String,
}

/// Control events forwarded to the webview as JSON over the PTY channel.
///
/// Terminal **output** does not travel as a `PtyEvent` — it is sent as a raw
/// `InvokeResponseBody::Raw` (an `ArrayBuffer` on the JS side) so it never gets
/// JSON-escaped (which would expand each `0x1B` ~6x) and is fed straight into
/// xterm as bytes. Only the low-volume title/exit events stay JSON.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Shell-emitted window title (OSC 0 / OSC 2). Stripped out of the output
    /// stream by the daemon. The frontend applies it to the tab strip only when
    /// the user has not manually renamed the tab.
    Title {
        title: String,
    },
    Exit {
        code: Option<i32>,
    },
}

impl PtyEvent {
    /// Serializes the event into a JSON channel message. Title/exit are tiny, so
    /// the JSON cost here is irrelevant compared to the output hot path.
    fn into_body(self) -> Option<InvokeResponseBody> {
        serde_json::to_string(&self)
            .ok()
            .map(InvokeResponseBody::Json)
    }
}

impl PtyClient {
    /// Builds a client whose daemon is isolated by the build's product identity
    /// (`product_name`): "Pragma Dev" → the `pragma-dev` channel, otherwise
    /// `pragma`. See `daemon_channel_for_product`.
    pub fn new(app_data_dir: PathBuf, product_name: Option<&str>) -> Self {
        Self {
            app_data_dir,
            channel: daemon_channel_for_product(product_name),
            launch_lock: Arc::new(Mutex::new(())),
            request_conn: Arc::new(Mutex::new(None)),
            input_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn spawn(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        self.stream(
            request_spawn(session_id, worktree_id, cwd, cols, rows),
            on_event,
        )
    }

    pub fn attach(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        self.stream(request_attach(session_id, cols, rows), on_event)
    }

    /// Enqueues keystroke input for the dedicated writer thread and returns
    /// immediately — input is fire-and-forget, so this never touches the socket
    /// or blocks on a daemon round-trip. The writer thread (lazily spawned on the
    /// first keystroke) owns its own connection and pipelines writes.
    pub fn write(&self, session_id: String, data: String) -> AppResult<()> {
        let mut guard = self.input_tx.lock()?;
        if guard.is_none() {
            *guard = Some(self.start_input_writer());
        }
        let msg = InputMsg { session_id, data };
        if let Err(err) = guard.as_ref().expect("input writer present").send(msg) {
            // The writer thread is gone (it only exits if it panics); restart it
            // and re-enqueue the keystroke that failed to send.
            let tx = self.start_input_writer();
            let _ = tx.send(err.0);
            *guard = Some(tx);
        }
        Ok(())
    }

    /// Spawns the dedicated input writer thread. It owns a single connection to
    /// the daemon, reconnecting (and respawning the daemon) on transport failure,
    /// and writes each queued keystroke frame fire-and-forget. A companion thread
    /// drains the daemon's per-write `Response` acknowledgements so the socket's
    /// receive buffer can't fill and back-pressure the daemon.
    fn start_input_writer(&self) -> Sender<InputMsg> {
        let (tx, rx) = mpsc::channel::<InputMsg>();
        let client = self.clone();
        thread::spawn(move || {
            let mut conn: Option<UnixStream> = None;
            for msg in rx {
                let frame = request_write(msg.session_id, msg.data);
                // Deliver the frame, reconnecting once if the socket is dead.
                for _ in 0..2 {
                    if conn.is_none() {
                        let Ok(stream) = client.connect_with_spawn() else {
                            break;
                        };
                        // The writer never reads, so drop the read timeout and let
                        // the discard thread block on the daemon's responses.
                        let _ = stream.set_read_timeout(None);
                        if let Ok(reader) = stream.try_clone() {
                            thread::spawn(move || discard_frames(reader));
                        }
                        conn = Some(stream);
                    }
                    let Some(stream) = conn.as_mut() else { break };
                    if write_json_frame(stream, &frame).is_ok() {
                        break;
                    }
                    // Transport failed — drop the dead stream and retry once.
                    conn = None;
                }
            }
        });
        tx
    }

    pub fn resize(&self, session_id: String, cols: u16, rows: u16) -> AppResult<()> {
        self.request(request_resize(session_id, cols, rows))
    }

    pub fn kill(&self, session_id: String) -> AppResult<()> {
        self.request(request_kill(session_id))
    }

    /// Asks the daemon to terminate every shell whose initial cwd is `path`
    /// (or lives underneath it). Used when deleting a worktree so the user's
    /// running processes don't keep an open handle to a now-removed directory.
    pub fn kill_for_cwd(&self, path: String) -> AppResult<()> {
        self.request(request_kill_for_cwd(path))
    }

    /// Kills the running daemon (if any) and spawns a fresh build, confirming the
    /// new daemon is reachable before returning. Every running shell session is
    /// terminated — this is a deliberate troubleshooting action surfaced through
    /// the menubar, not a routine operation.
    pub fn restart(&self) -> AppResult<()> {
        // Drop the pooled connections up front (in their own scope so the locks
        // are released before we take `launch_lock`); they point at the daemon
        // we're about to kill. A later request()/write() lazily reconnects to the
        // fresh one. Dropping the input sender ends its writer thread, which
        // releases the stale input connection.
        *self.request_conn.lock()? = None;
        *self.input_tx.lock()? = None;
        {
            let _guard = self.launch_lock.lock()?;
            self.kill_stale_daemon();
            self.spawn_daemon()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.connect_compatible() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    return Err(AppError::Daemon(
                        "daemon did not become reachable after restart".to_string(),
                    ))
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Reads the daemon's log file, returning an empty string if it has not been
    /// created yet. Used by the menubar's "Open Daemon Logs" action; the path is
    /// derived entirely backend-side and never crosses IPC.
    pub fn read_log(&self) -> AppResult<String> {
        match std::fs::read_to_string(self.log_path()) {
            Ok(contents) => Ok(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(AppError::from(err)),
        }
    }

    fn stream(
        &self,
        request: RequestFrame,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        let mut stream = self.connect_with_spawn()?;
        write_json_frame(&mut stream, &request)?;
        let request_id = request.request_id.clone();
        loop {
            match read_json_frame::<ServerFrame>(&mut stream)? {
                ServerFrame::Response(response) if response.request_id == request_id => {
                    if !response.ok {
                        return Err(AppError::Daemon(
                            response
                                .error
                                .unwrap_or_else(|| "daemon stream request failed".to_string()),
                        ));
                    }
                    stream.set_read_timeout(None)?;
                    break;
                }
                ServerFrame::Hello(_) | ServerFrame::Response(_) | ServerFrame::Event(_) => {}
            }
        }
        thread::spawn(move || {
            while let Ok(frame) = read_frame(&mut stream) {
                match frame {
                    // Output is forwarded verbatim as raw bytes (an ArrayBuffer on
                    // the JS side) — no JSON, no UTF-8 decode, straight into xterm.
                    // A send error means the frontend dropped the channel (window/
                    // tab closed); stop draining so the socket and daemon-side
                    // forwarder thread are released instead of blocking forever.
                    Frame::Output { data, .. } => {
                        if on_event.send(InvokeResponseBody::Raw(data)).is_err() {
                            break;
                        }
                    }
                    Frame::Json(bytes) => match serde_json::from_slice::<ServerFrame>(&bytes) {
                        Ok(ServerFrame::Event(EventFrame::Title { title, .. })) => {
                            if forward_event(&on_event, PtyEvent::Title { title }).is_err() {
                                break;
                            }
                        }
                        Ok(ServerFrame::Event(EventFrame::Exit { code, .. })) => {
                            let _ = forward_event(&on_event, PtyEvent::Exit { code });
                            break;
                        }
                        Ok(
                            ServerFrame::Hello(_)
                            | ServerFrame::Response(_)
                            | ServerFrame::Event(
                                EventFrame::Output { .. } | EventFrame::Agent { .. },
                            ),
                        )
                        | Err(_) => {}
                    },
                }
            }
            let _ = stream.shutdown(Shutdown::Both);
        });
        Ok(())
    }

    fn request(&self, request: RequestFrame) -> AppResult<()> {
        let mut guard = self.request_conn.lock()?;
        // Reuse the pooled connection. A transport failure means the daemon went
        // away (restarted or idle-exited), so drop the dead stream and retry once
        // with a freshly spawned one; a daemon-level error response is returned
        // as-is without reconnecting.
        let mut last_err: Option<AppError> = None;
        for _ in 0..2 {
            if guard.is_none() {
                *guard = Some(self.connect_with_spawn()?);
            }
            let stream = guard.as_mut().expect("connection just established");
            match Self::request_on(stream, &request) {
                Ok(result) => return result,
                Err(transport_err) => {
                    *guard = None;
                    last_err = Some(transport_err);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| AppError::Daemon("daemon request failed".to_string())))
    }

    /// Sends `request` on an already-connected stream and waits for its matching
    /// response. The outer `Err` signals a transport failure (the caller should
    /// drop the connection and reconnect); the inner `AppResult` carries the
    /// daemon's own success/error for the request.
    fn request_on(
        stream: &mut UnixStream,
        request: &RequestFrame,
    ) -> Result<AppResult<()>, AppError> {
        write_json_frame(stream, request)?;
        loop {
            match read_json_frame::<ServerFrame>(stream)? {
                ServerFrame::Response(response) if response.request_id == request.request_id => {
                    return Ok(if response.ok {
                        Ok(())
                    } else {
                        Err(AppError::Daemon(
                            response
                                .error
                                .unwrap_or_else(|| "daemon request failed".to_string()),
                        ))
                    });
                }
                ServerFrame::Hello(_) | ServerFrame::Response(_) | ServerFrame::Event(_) => {}
            }
        }
    }

    pub(crate) fn connect_with_spawn(&self) -> AppResult<UnixStream> {
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        let _guard = self.launch_lock.lock()?;
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        self.spawn_daemon()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.connect_compatible() {
                Ok(Some(stream)) => return Ok(stream),
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    return Err(AppError::Daemon(
                        "daemon did not become reachable".to_string(),
                    ))
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Connects to a daemon already listening on the socket and verifies it
    /// speaks our protocol version via its hello frame. Returns the ready stream
    /// (positioned just after the hello) when compatible, or `Ok(None)` when no
    /// daemon is reachable. A reachable-but-incompatible daemon — including an
    /// old build that predates the hello and so never sends one — is killed
    /// before returning `Ok(None)` so the caller respawns a matching daemon.
    fn connect_compatible(&self) -> AppResult<Option<UnixStream>> {
        let Ok(mut stream) = UnixStream::connect(self.socket_path()) else {
            return Ok(None);
        };
        configure_stream(&stream)?;
        // The hello arrives immediately from a healthy daemon; cap the wait so a
        // stale daemon that never greets us doesn't stall startup.
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let expected = CONSTANTS.daemon.protocol_version.get();
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Hello(hello)) if hello.protocol_version == expected => {
                configure_stream(&stream)?;
                Ok(Some(stream))
            }
            _ => {
                self.kill_stale_daemon();
                Ok(None)
            }
        }
    }

    /// Terminates a daemon whose protocol no longer matches this build. Uses the
    /// PID the daemon records in its lock file for a precise kill, falling back
    /// to `pkill` for older daemons that predate the pidfile. Removes the stale
    /// socket so the next spawn binds cleanly.
    fn kill_stale_daemon(&self) {
        let killed_by_pid = std::fs::read_to_string(self.lock_path())
            .ok()
            .and_then(|contents| contents.trim().parse::<u32>().ok())
            .is_some_and(|pid| {
                Command::new("kill")
                    .arg("-KILL")
                    .arg(pid.to_string())
                    .status()
                    .is_ok_and(|status| status.success())
            });
        if !killed_by_pid {
            // Pre-handshake daemons left no usable pidfile; match by command line.
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", "pragma-daemon"])
                .status();
        }
        // Let the OS reap the process and release the socket before respawning.
        thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_file(self.socket_path());
        let _ = std::fs::remove_file(self.lock_path());
    }

    fn lock_path(&self) -> PathBuf {
        self.socket_path().with_file_name("daemon.lock")
    }

    /// The daemon's log file, alongside its socket. Mirrors the path the daemon
    /// itself writes to after detaching (see `pragma-daemon`'s `daemon_paths`),
    /// so it stays correct on Linux where the runtime dir differs from app data.
    fn log_path(&self) -> PathBuf {
        self.socket_path().with_file_name("daemon.log")
    }

    /// Directory the daemon owns — its socket, lock, and log all live here. It
    /// is **channel-scoped** (`DAEMON_CHANNEL`) so a dev build and a production
    /// build never share a daemon. On Linux it lives under the XDG runtime dir;
    /// elsewhere, under the app-data dir. Mirrored by `pragma-daemon`'s
    /// `daemon_paths` so both processes resolve the identical path.
    fn daemon_dir(&self) -> PathBuf {
        if cfg!(target_os = "linux") {
            std::env::var_os("XDG_RUNTIME_DIR").map_or_else(
                || self.app_data_dir.join(&self.channel),
                |dir| PathBuf::from(dir).join(&self.channel),
            )
        } else {
            self.app_data_dir.join(&self.channel)
        }
    }

    fn socket_path(&self) -> PathBuf {
        self.daemon_dir().join("daemon.sock")
    }

    fn spawn_daemon(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.app_data_dir)?;
        // The log may live outside app data (the XDG runtime dir on Linux); make
        // sure its directory exists before redirecting the child's output to it.
        if let Some(parent) = self.log_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut command = if cfg!(debug_assertions) {
            let mut command = Command::new(cargo_executable());
            command.args(["run", "-p", "pragma-daemon", "--", DAEMON_DETACH_FLAG]);
            command.current_dir(workspace_root());
            command
        } else {
            let mut command = Command::new(daemon_executable());
            command.arg(DAEMON_DETACH_FLAG);
            command
        };
        command
            .env("PRAGMA_APP_DATA_DIR", &self.app_data_dir)
            .env("PRAGMA_DAEMON_CHANNEL", &self.channel)
            .stdin(Stdio::null());
        if let Ok(log_file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
        {
            if let Ok(stderr) = log_file.try_clone() {
                command.stdout(log_file).stderr(stderr);
            }
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        let mut child = command.spawn()?;
        thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

fn request_spawn(
    session_id: String,
    worktree_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> RequestFrame {
    request_frame(
        RequestKind::Spawn,
        Some(session_id),
        Some(worktree_id),
        Some(cwd),
        Some(cols),
        Some(rows),
        None,
    )
}

fn request_attach(session_id: String, cols: u16, rows: u16) -> RequestFrame {
    request_frame(
        RequestKind::Attach,
        Some(session_id),
        None,
        None,
        Some(cols),
        Some(rows),
        None,
    )
}

fn request_write(session_id: String, data: String) -> RequestFrame {
    request_frame(
        RequestKind::Write,
        Some(session_id),
        None,
        None,
        None,
        None,
        Some(data),
    )
}

fn request_resize(session_id: String, cols: u16, rows: u16) -> RequestFrame {
    request_frame(
        RequestKind::Resize,
        Some(session_id),
        None,
        None,
        Some(cols),
        Some(rows),
        None,
    )
}

fn request_kill(session_id: String) -> RequestFrame {
    request_frame(
        RequestKind::Kill,
        Some(session_id),
        None,
        None,
        None,
        None,
        None,
    )
}

fn request_kill_for_cwd(cwd: String) -> RequestFrame {
    request_frame(
        RequestKind::KillForCwd,
        None,
        None,
        None,
        None,
        None,
        Some(cwd),
    )
}

fn request_frame(
    kind: RequestKind,
    session_id: Option<String>,
    worktree_id: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    data: Option<String>,
) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind,
        session_id,
        worktree_id,
        cwd,
        cols,
        rows,
        data,
    }
}

/// Maps the build's product name to the daemon channel that isolates it from a
/// differently-built sibling: a dev build ("Pragma Dev") and a production build
/// ("Pragma") must never share a daemon, socket, lock, or log — otherwise
/// launching "Pragma Dev" would attach to "Pragma"'s shells, or vice versa.
///
/// Keying off the **product identity** rather than the compile profile is
/// deliberate: a release-built dev app (e.g. when profiling terminal latency)
/// is still a dev app and must keep its own daemon. The chosen channel is passed
/// to `pragma-daemon` via `PRAGMA_DAEMON_CHANNEL` so both processes agree.
fn daemon_channel_for_product(product_name: Option<&str>) -> String {
    match product_name {
        Some(name) if name.contains("Dev") => "pragma-dev".to_string(),
        _ => "pragma".to_string(),
    }
}

fn daemon_executable() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map_or_else(
            || PathBuf::from("pragma-daemon"),
            |dir| dir.join("pragma-daemon"),
        )
}

pub(crate) fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map_or_else(|| PathBuf::from(name), |dir| dir.join(name))
}

pub(crate) fn cargo_executable() -> PathBuf {
    if let Some(cargo) = option_env!("CARGO") {
        return PathBuf::from(cargo);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cargo = PathBuf::from(home).join(".cargo/bin/cargo");
        if cargo.is_file() {
            return cargo;
        }
    }
    for candidate in [
        "/opt/homebrew/bin/cargo",
        "/usr/local/bin/cargo",
        "/usr/bin/cargo",
    ] {
        let cargo = PathBuf::from(candidate);
        if cargo.is_file() {
            return cargo;
        }
    }
    PathBuf::from("cargo")
}

pub(crate) fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<root>/apps/pragma/src-tauri`; the workspace root is
    // three ancestors up (src-tauri -> pragma -> apps -> <root>).
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn configure_stream(stream: &UnixStream) -> AppResult<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(())
}

/// Drains and discards every frame from the input connection until it closes.
/// The daemon answers each fire-and-forget `write` with a `Response`; we don't
/// need the acknowledgement, but the socket must still be read so its receive
/// buffer can't fill and back-pressure the daemon's writes.
fn discard_frames(mut reader: UnixStream) {
    while read_frame(&mut reader).is_ok() {}
}

/// Forwards a JSON control event (title/exit) to the webview. Returns the
/// channel's send result so the caller can stop on a dropped channel.
fn forward_event(channel: &Channel<InvokeResponseBody>, event: PtyEvent) -> tauri::Result<()> {
    match event.into_body() {
        Some(body) => channel.send(body),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{daemon_channel_for_product, PtyClient};

    /// The daemon log must live next to the socket so we read exactly where the
    /// detached daemon writes (the runtime dir on Linux, app data on macOS).
    #[test]
    fn log_path_sits_beside_socket() {
        let client = PtyClient::new(std::path::PathBuf::from("/tmp/pragma-test"), Some("Pragma"));
        let socket = client.socket_path();
        let log = client.log_path();
        assert_eq!(log.parent(), socket.parent());
        assert_eq!(log.file_name().and_then(|n| n.to_str()), Some("daemon.log"));
    }

    /// The daemon's socket/lock/log sit in a channel-scoped directory so a dev
    /// build and a production build never resolve the same daemon.
    #[test]
    fn daemon_paths_are_channel_scoped() {
        let client = PtyClient::new(
            std::path::PathBuf::from("/tmp/pragma-test"),
            Some("Pragma Dev"),
        );
        let socket = client.socket_path();
        let channel_dir = socket.parent().expect("socket has a parent dir");
        assert_eq!(
            channel_dir.file_name().and_then(|n| n.to_str()),
            Some("pragma-dev"),
        );
    }

    /// The channel is chosen from the build's product identity — not the compile
    /// profile — so a release-built dev app keeps its own daemon.
    #[test]
    fn channel_follows_product_identity() {
        assert_eq!(daemon_channel_for_product(Some("Pragma Dev")), "pragma-dev");
        assert_eq!(daemon_channel_for_product(Some("Pragma")), "pragma");
        assert_eq!(daemon_channel_for_product(None), "pragma");
    }

    /// Reading a daemon log that has never been created reports an empty string
    /// rather than erroring, so the log tab opens cleanly on a fresh install.
    #[test]
    fn read_log_is_empty_when_missing() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Force the macOS-style path (socket/log under app data) regardless of the
        // host so the temp dir fully isolates the test from any real daemon log.
        let prev = std::env::var_os("XDG_RUNTIME_DIR");
        std::env::remove_var("XDG_RUNTIME_DIR");
        let client = PtyClient::new(dir.path().to_path_buf(), Some("Pragma"));
        assert_eq!(client.read_log().expect("read empty log"), "");
        std::fs::create_dir_all(client.log_path().parent().expect("log dir"))
            .expect("create channel dir");
        std::fs::write(client.log_path(), "boot\n").expect("write log");
        assert_eq!(client.read_log().expect("read log"), "boot\n");
        if let Some(value) = prev {
            std::env::set_var("XDG_RUNTIME_DIR", value);
        }
    }
}
