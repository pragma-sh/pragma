mod protocol;
mod registry;
mod session;

use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use protocol::{read_request, write_frame, Request, Response};
use registry::Registry;

/// How long the daemon waits, with no sessions and no clients, before exiting.
const IDLE_SHUTDOWN_SECS: u64 = 5;

/// Decrements the live-connection counter when a client handler returns.
struct ConnectionGuard<'a>(&'a AtomicUsize);

impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: pragma-daemon <socket-path>");
        std::process::exit(1);
    }
    let socket_path = &args[1];

    if let Some(parent) = std::path::Path::new(socket_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let listener = match bind_socket(socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("failed to bind socket: {e}");
            std::process::exit(1);
        }
    };

    let registry = Arc::new(Mutex::new(Registry::new()));
    // Number of live client connections. The daemon must not exit while a
    // client is attached, even with zero sessions (e.g. a window is open but
    // every tab was just closed, or a client is mid-reattach).
    let connections = Arc::new(AtomicUsize::new(0));

    spawn_idle_watchdog(
        Arc::clone(&registry),
        Arc::clone(&connections),
        socket_path.clone(),
    );

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let reg = Arc::clone(&registry);
                let conns = Arc::clone(&connections);
                thread::spawn(move || {
                    handle_client(stream, reg, conns);
                });
            }
            Err(e) => {
                eprintln!("accept error: {e}");
            }
        }
    }

    let _ = std::fs::remove_file(socket_path);
}

/// Exit the process once it has been idle — no sessions and no connected
/// clients — for `IDLE_SHUTDOWN_SECS`, so the daemon never leaks forever.
fn spawn_idle_watchdog(
    registry: Arc<Mutex<Registry>>,
    connections: Arc<AtomicUsize>,
    socket_path: String,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(IDLE_SHUTDOWN_SECS));
        let idle = connections.load(Ordering::SeqCst) == 0
            && registry.lock().unwrap().session_count() == 0;
        if idle {
            let _ = std::fs::remove_file(&socket_path);
            std::process::exit(0);
        }
    });
}

fn bind_socket(path: &str) -> std::io::Result<UnixListener> {
    match UnixListener::bind(path) {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if let Ok(_) = UnixStream::connect(path) {
                eprintln!("daemon already running, exiting");
                std::process::exit(0);
            } else {
                let _ = std::fs::remove_file(path);
                UnixListener::bind(path)
            }
        }
        Err(e) => Err(e),
    }
}

fn handle_client(
    stream: UnixStream,
    registry: Arc<Mutex<Registry>>,
    connections: Arc<AtomicUsize>,
) {
    connections.fetch_add(1, Ordering::SeqCst);
    let _guard = ConnectionGuard(&connections);

    let mut reader = stream
        .try_clone()
        .expect("failed to clone stream for reading");
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(stream)));

    loop {
        let request = match read_request(&mut reader) {
            Ok(r) => r,
            Err(_) => break,
        };

        match request {
            Request::Ping => {
                let mut w = writer.lock().unwrap();
                let _ = write_frame(&mut *w, &Response::Ok);
            }
            Request::Spawn {
                session_id,
                cwd,
                cols,
                rows,
            } => {
                registry
                    .lock()
                    .unwrap()
                    .spawn(session_id, &cwd, cols, rows, &writer);
            }
            Request::Attach {
                session_id,
                cols,
                rows,
            } => {
                registry
                    .lock()
                    .unwrap()
                    .attach(&session_id, cols, rows, &writer);
            }
            Request::Write { session_id, data } => {
                registry.lock().unwrap().write(&session_id, &data, &writer);
            }
            Request::Resize {
                session_id,
                cols,
                rows,
            } => {
                registry
                    .lock()
                    .unwrap()
                    .resize(&session_id, cols, rows, &writer);
            }
            Request::Kill { session_id } => {
                let killed = registry.lock().unwrap().kill(&session_id);
                if killed {
                    let mut w = writer.lock().unwrap();
                    let _ = write_frame(&mut *w, &Response::Ok);
                }
            }
        }
    }
}
