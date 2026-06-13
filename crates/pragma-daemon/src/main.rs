mod protocol;
mod registry;
mod session;

use std::fs::{self, File, OpenOptions};
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use protocol::{
    read_frame, write_frame, EventFrame, RequestFrame, RequestKind, ResponseFrame, ServerFrame,
};
use registry::Registry;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = daemon_paths();
    fs::create_dir_all(&paths.dir)?;
    remove_stale_files(&paths.socket, &paths.lock);
    let _lock = acquire_lock(&paths.lock)?;
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }
    let listener = UnixListener::bind(&paths.socket)?;
    listener.set_nonblocking(true)?;

    let registry = Arc::new(Registry::default());
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

fn handle_client(mut stream: UnixStream, registry: &Registry) {
    let writer = match stream.try_clone() {
        Ok(stream) => Arc::new(Mutex::new(stream)),
        Err(_) => return,
    };
    while let Ok(request) = read_frame::<RequestFrame>(&mut stream) {
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
            if write_frame(&mut *writer_guard, &ServerFrame::Response(response)).is_err() {
                break;
            }
        }
        if let Some(stream) = event_stream {
            forward_events(stream.scrollback, stream.rx, Arc::clone(&writer));
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
            let cwd = required(request.cwd, "cwd")?;
            let cols = request.cols.unwrap_or(80);
            let rows = request.rows.unwrap_or(24);
            let (scrollback, rx) = registry
                .spawn(session_id, cwd, cols, rows)
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
) {
    thread::spawn(move || {
        for event in scrollback {
            if let Ok(mut writer) = writer.lock() {
                let _ = write_frame(&mut *writer, &ServerFrame::Event(event));
            }
        }
        for event in rx {
            if let Ok(mut writer) = writer.lock() {
                if write_frame(&mut *writer, &ServerFrame::Event(event)).is_err() {
                    break;
                }
            }
        }
    });
}

fn required(value: Option<String>, name: &str) -> Result<String, String> {
    value.ok_or_else(|| format!("missing {name}"))
}

struct DaemonPaths {
    dir: PathBuf,
    socket: PathBuf,
    lock: PathBuf,
}

fn daemon_paths() -> DaemonPaths {
    let dir = if cfg!(target_os = "linux") {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(|dir| PathBuf::from(dir).join("pragma"))
            .or_else(|| std::env::var_os("PRAGMA_APP_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(default_app_data_dir)
    } else {
        std::env::var_os("PRAGMA_APP_DATA_DIR").map_or_else(default_app_data_dir, PathBuf::from)
    };
    DaemonPaths {
        socket: dir.join("daemon.sock"),
        lock: dir.join("daemon.lock"),
        dir,
    }
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
