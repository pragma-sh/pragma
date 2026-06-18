mod registry;
mod session;

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use daemonize::Daemonize;
use pragma_constants::CONSTANTS;

use pragma_protocol::{
    read_json_frame, write_json_frame, write_output_frame, EventFrame, HelloFrame, ProtocolError,
    RequestFrame, RequestKind, ResponseFrame, ServerFrame,
};
use registry::Registry;

const DETACH_FLAG: &str = "--detach";

/// Build channel used to isolate this daemon from a differently-built sibling.
/// The Pragma app picks the channel from its product identity (see
/// `daemon_channel_for_product` in `pty.rs`) and hands it to us via
/// `PRAGMA_DAEMON_CHANNEL` when it spawns us, so a dev daemon and a prod daemon
/// resolve different socket/lock/log paths regardless of compile profile. This
/// compile-profile default only applies when the daemon is run by hand.
const DEFAULT_DAEMON_CHANNEL: &str = if cfg!(debug_assertions) {
    "pragma-dev"
} else {
    "pragma"
};

/// The channel the app handed us, falling back to the compile-profile default
/// when the daemon is launched directly (e.g. `cargo run -p pragma-daemon`).
fn daemon_channel() -> String {
    std::env::var("PRAGMA_DAEMON_CHANNEL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_CHANNEL.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = daemon_paths();
    fs::create_dir_all(&paths.dir)?;
    detach_if_requested(&paths, should_detach())?;
    remove_stale_files(&paths.socket, &paths.lock);
    let mut lock = acquire_lock(&paths.lock)?;
    // Record our PID so the app can replace *this* daemon precisely if it ever
    // turns out to speak an incompatible protocol version (see the hello frame).
    writeln!(lock, "{}", std::process::id())?;
    lock.flush()?;
    let _lock = lock;
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }
    let listener = UnixListener::bind(&paths.socket)?;
    listener.set_nonblocking(true)?;

    let registry = Arc::new(Registry::new(paths.socket.clone()));
    let clients = Arc::new(AtomicUsize::new(0));

    let mut idle_since: Option<Instant> = None;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                idle_since = None;
                clients.fetch_add(1, Ordering::SeqCst);
                let registry = Arc::clone(&registry);
                let clients = Arc::clone(&clients);
                thread::spawn(move || {
                    handle_client(stream, &registry);
                    clients.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if clients.load(Ordering::SeqCst) == 0 && registry.is_empty() {
                    let since = idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(30) {
                        break;
                    }
                } else {
                    idle_since = None;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(Box::new(err)),
        }
    }

    let _ = fs::remove_file(paths.socket);
    let _ = fs::remove_file(paths.lock);
    Ok(())
}

fn handle_client(mut stream: UnixStream, registry: &Arc<Registry>) {
    let writer = match stream.try_clone() {
        Ok(stream) => Arc::new(Mutex::new(stream)),
        Err(_) => return,
    };
    // Greet the connection so the app can verify it is talking to a daemon that
    // speaks its protocol version (and replace it otherwise). Must be the first
    // frame written; the app consumes exactly one hello before any request.
    if let Ok(mut writer_guard) = writer.lock() {
        let hello = ServerFrame::Hello(HelloFrame {
            protocol_version: CONSTANTS.daemon.protocol_version.get(),
        });
        if write_json_frame(&mut *writer_guard, &hello).is_err() {
            return;
        }
    }
    while let Ok(request) = read_json_frame::<RequestFrame>(&mut stream) {
        let request_id = request.request_id.clone();
        let (response, event_stream) = match handle_request(request, registry) {
            Ok(event_stream) => (
                ResponseFrame {
                    request_id: request_id.clone(),
                    ok: true,
                    error: None,
                },
                event_stream,
            ),
            Err(error) => (
                ResponseFrame {
                    request_id: request_id.clone(),
                    ok: false,
                    error: Some(error),
                },
                None,
            ),
        };
        if let Ok(mut writer_guard) = writer.lock() {
            if write_json_frame(&mut *writer_guard, &ServerFrame::Response(response)).is_err() {
                break;
            }
        }
        if let Some(stream) = event_stream {
            forward_events(
                stream.scrollback,
                stream.rx,
                Arc::clone(&writer),
                Arc::clone(registry),
            );
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn handle_request(
    request: RequestFrame,
    registry: &Registry,
) -> Result<Option<EventStream>, String> {
    match request.kind {
        RequestKind::Spawn => {
            let session_id = required(request.session_id, "sessionId")?;
            let worktree_id = required(request.worktree_id, "worktreeId")?;
            let cwd = required(request.cwd, "cwd")?;
            let cols = request.cols.unwrap_or(80);
            let rows = request.rows.unwrap_or(24);
            let (scrollback, rx) = registry
                .spawn(session_id, worktree_id, cwd, cols, rows)
                .map_err(|err| err.to_string())?;
            Ok(Some(EventStream { scrollback, rx }))
        }
        RequestKind::Attach => {
            let session_id = required(request.session_id, "sessionId")?;
            let cols = request.cols.unwrap_or(80);
            let rows = request.rows.unwrap_or(24);
            let (scrollback, rx) = registry
                .attach(&session_id, cols, rows)
                .map_err(|err| err.to_string())?;
            Ok(Some(EventStream { scrollback, rx }))
        }
        RequestKind::Write => registry
            .write(
                &required(request.session_id, "sessionId")?,
                &required(request.data, "data")?,
            )
            .map(|()| None)
            .map_err(|err| err.to_string()),
        RequestKind::Resize => registry
            .resize(
                &required(request.session_id, "sessionId")?,
                request.cols.unwrap_or(80),
                request.rows.unwrap_or(24),
            )
            .map(|()| None)
            .map_err(|err| err.to_string()),
        RequestKind::Kill => registry
            .kill(&required(request.session_id, "sessionId")?)
            .map(|()| None)
            .map_err(|err| err.to_string()),
        RequestKind::KillForCwd => registry
            .kill_for_cwd(&required(request.data, "data")?)
            .map(|_count| None)
            .map_err(|err| err.to_string()),
        RequestKind::AgentReport => {
            let payload = serde_json::from_str(&required(request.data, "data")?)
                .map_err(|err| err.to_string())?;
            registry
                .report_agent(payload)
                .map(|()| None)
                .map_err(|err| err.to_string())
        }
        RequestKind::SubscribeAgents => {
            let (scrollback, rx) = registry.subscribe_agents().map_err(|err| err.to_string())?;
            Ok(Some(EventStream { scrollback, rx }))
        }
    }
}

struct EventStream {
    scrollback: Vec<EventFrame>,
    rx: Receiver<EventFrame>,
}

fn forward_events(
    scrollback: Vec<EventFrame>,
    rx: Receiver<EventFrame>,
    writer: Arc<Mutex<UnixStream>>,
    registry: Arc<Registry>,
) {
    thread::spawn(move || {
        for event in scrollback {
            if let Ok(mut writer) = writer.lock() {
                let _ = write_event(&mut writer, event);
            }
        }
        for event in rx {
            if let EventFrame::Exit { session_id, .. } = &event {
                registry.clear_agents_for_tab(session_id);
            }
            if let Ok(mut writer) = writer.lock() {
                if write_event(&mut writer, event).is_err() {
                    break;
                }
            }
        }
    });
}

/// Writes one event to the client: output goes out as a binary frame (raw bytes,
/// no JSON escaping), while title/exit stay JSON control frames.
fn write_event(writer: &mut UnixStream, event: EventFrame) -> Result<(), ProtocolError> {
    match event {
        EventFrame::Output { session_id, data } => write_output_frame(writer, &session_id, &data),
        other => write_json_frame(writer, &ServerFrame::Event(other)),
    }
}

fn required(value: Option<String>, name: &str) -> Result<String, String> {
    value.ok_or_else(|| format!("missing {name}"))
}

struct DaemonPaths {
    dir: PathBuf,
    socket: PathBuf,
    lock: PathBuf,
    log: PathBuf,
}

fn daemon_paths() -> DaemonPaths {
    let channel = daemon_channel();
    let dir = if cfg!(target_os = "linux") {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("PRAGMA_APP_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(default_app_data_dir)
            .join(&channel)
    } else {
        std::env::var_os("PRAGMA_APP_DATA_DIR")
            .map_or_else(default_app_data_dir, PathBuf::from)
            .join(&channel)
    };
    DaemonPaths {
        socket: dir.join("daemon.sock"),
        lock: dir.join("daemon.lock"),
        log: dir.join("daemon.log"),
        dir,
    }
}

fn should_detach() -> bool {
    std::env::args_os().any(|arg| arg == OsStr::new(DETACH_FLAG))
}

fn detach_if_requested(
    paths: &DaemonPaths,
    should_detach: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !should_detach {
        return Ok(());
    }

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;
    let stderr = stdout.try_clone()?;
    Daemonize::new()
        .working_directory(&paths.dir)
        .stdout(stdout)
        .stderr(stderr)
        .start()?;
    Ok(())
}

fn default_app_data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(std::env::temp_dir, PathBuf::from);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.pragma.app")
    } else {
        home.join(".local/share/com.pragma.app")
    }
}

fn acquire_lock(lock_path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .map_err(|err| {
            format!(
                "pragma-daemon is already running or lock is stale at {}: {err}",
                lock_path.display()
            )
            .into()
        })
}

fn remove_stale_files(socket: &Path, lock: &Path) {
    if socket.exists() && UnixStream::connect(socket).is_err() {
        let _ = fs::remove_file(socket);
        let _ = fs::remove_file(lock);
    } else if lock.exists() && !socket.exists() {
        let _ = fs::remove_file(lock);
    }
}
