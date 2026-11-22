//! The server's listening socket, kept able to serve for the whole run.
//!
//! On macOS a listening socket can lose its receive side while the process
//! keeps running (#221, #225). XNU then fails every `accept` on an empty
//! queue with `ECONNABORTED`, and because `sonewconn` copies the listener's
//! state into each connection it creates, every connection it does hand out
//! is born unable to receive: the server writes its hello, reads end-of-file
//! at once, and hangs up. Clients see a good hello followed by a broken pipe,
//! so new terminals fail to start until the server is restarted, while the
//! sessions already attached keep working.
//!
//! A healthy listener does not return `ECONNABORTED` in practice — XNU only
//! does so for a listener that cannot receive, or when it runs out of memory
//! for one address — so a burst of them is the signal. [`ServerListener`]
//! answers it by binding a fresh socket and renaming it over the old path,
//! which keeps every live session instead of restarting the server.

use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use pragma_platform::ipc::{self, LocalListener, LocalStream};

/// Aborted accepts within [`ABORT_WINDOW`] that mean the listener is broken.
const ABORT_LIMIT: u32 = 3;

/// The window [`ABORT_LIMIT`] aborted accepts must fall in.
const ABORT_WINDOW: Duration = Duration::from_secs(1);

/// Pause after an aborted accept: short, since it is not a resource shortage,
/// but enough to keep a broken listener from spinning a core.
const ABORT_BACKOFF: Duration = Duration::from_millis(10);

/// Pause after any other accept failure, such as `EMFILE`: these clear only
/// once something else releases a resource.
const FAILURE_BACKOFF: Duration = Duration::from_millis(100);

/// Minimum spacing between two replacements, so a process whose every new
/// socket is broken logs once a second instead of rebinding in a hot loop.
const REPLACE_COOLDOWN: Duration = Duration::from_secs(1);

/// Suffix of the path a replacement socket is bound at before it is renamed
/// over the served path.
/// File name of the staging socket, a sibling of the real one. Deliberately
/// shorter than any plausible socket name: appending a suffix to the live path
/// would overflow the OS `sun_path` limit for a path that only just fits.
const REPLACEMENT_NAME: &str = ".n";

/// The listening socket at `path`, replaced in place when it stops working.
pub struct ServerListener {
    path: PathBuf,
    listener: LocalListener,
    aborts: u32,
    first_abort: Option<Instant>,
    last_replaced: Option<Instant>,
}

impl ServerListener {
    /// Wraps `listener`, which must be bound at `path`.
    pub fn new(path: PathBuf, listener: LocalListener) -> Self {
        Self {
            path,
            listener,
            aborts: 0,
            first_abort: None,
            last_replaced: None,
        }
    }

    /// Waits for the next connection. Accept failures are handled here, so
    /// this only ever returns a connection.
    pub fn accept(&mut self) -> LocalStream {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return stream,
                Err(error) if error.kind() == io::ErrorKind::ConnectionAborted => {
                    self.on_aborted(&error);
                }
                Err(error) => {
                    // Not fatal: one failed accept (e.g. EMFILE from fd
                    // exhaustion) must not take every connected terminal down
                    // with the process. It usually clears once connections
                    // close, so keep serving at a bounded retry rate.
                    eprintln!("accept failed: {error}");
                    thread::sleep(FAILURE_BACKOFF);
                }
            }
        }
    }

    fn on_aborted(&mut self, error: &io::Error) {
        let now = Instant::now();
        match self.first_abort {
            Some(first) if now.duration_since(first) <= ABORT_WINDOW => self.aborts += 1,
            _ => {
                self.first_abort = Some(now);
                self.aborts = 1;
            }
        }
        if self.aborts < ABORT_LIMIT {
            thread::sleep(ABORT_BACKOFF);
            return;
        }
        if let Some(wait) = self
            .last_replaced
            .and_then(|last| REPLACE_COOLDOWN.checked_sub(now.duration_since(last)))
        {
            thread::sleep(wait);
        }
        self.aborts = 0;
        self.first_abort = None;
        self.last_replaced = Some(Instant::now());
        match bind_replacement(&self.path) {
            Ok(listener) => {
                // Dropping the old socket also drops anything still queued on
                // it; those connections inherited its broken state anyway.
                self.listener = listener;
                eprintln!(
                    "listening socket stopped accepting connections ({error}); \
                     replaced it at {}",
                    self.path.display()
                );
            }
            Err(replace_error) => eprintln!(
                "listening socket stopped accepting connections ({error}); \
                 could not replace it: {replace_error}"
            ),
        }
    }
}

/// Binds a fresh listener and renames it over `path`.
///
/// Binding beside the old socket and renaming it into place means a client
/// connecting during the swap reaches one socket or the other, never a missing
/// path. A missing path would read as "no server", and the client would start
/// a second one.
fn bind_replacement(path: &Path) -> io::Result<LocalListener> {
    let staging = path.with_file_name(REPLACEMENT_NAME);
    match std::fs::remove_file(&staging) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = ipc::bind(&staging)?;
    if let Err(error) = std::fs::rename(&staging, path) {
        let _ = std::fs::remove_file(&staging);
        return Err(error);
    }
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use pragma_platform::ipc;

    use super::ServerListener;

    #[test]
    fn a_healthy_listener_is_left_alone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("daemon.sock");
        let mut listener = ServerListener::new(path.clone(), ipc::bind(&path).expect("bind"));
        let client = std::thread::spawn(move || ipc::connect(&path).expect("connect"));
        let _accepted = listener.accept();
        let _client = client.join().expect("client thread");
        assert!(listener.last_replaced.is_none());
    }

    #[test]
    fn replacement_binds_when_the_path_is_near_the_socket_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Pad the directory so the socket path sits a couple of bytes under the
        // 104-byte macOS `sun_path` limit (the smallest of the supported OSes).
        let base = dir.path().as_os_str().len() + "/daemon.sock".len();
        let pad = 100usize.saturating_sub(base);
        let nested = dir.path().join("p".repeat(pad.max(1)));
        std::fs::create_dir_all(&nested).expect("nested dir");
        let path = nested.join("daemon.sock");
        let Ok(old) = ipc::bind(&path) else { return };
        drop(old);
        super::bind_replacement(&path).expect("replacement fits near the path limit");
    }

    #[cfg(target_os = "macos")]
    mod broken {
        use std::io::{Read, Write};
        use std::path::Path;
        use std::time::{Duration, Instant};

        use pragma_platform::ipc::{self, LocalListener};
        use socket2::{Domain, SockAddr, Socket, Type};

        use super::ServerListener;

        /// A listening socket in the state #225's servers were found in:
        /// bound, briefly connected to a throwaway peer that then hung up, and
        /// only then put into listening. That leaves its receive and send
        /// sides shut, which XNU lets a listener carry and copies into every
        /// connection it accepts. This is the real kernel state, not a
        /// stand-in for it.
        fn broken_listener(dir: &Path) -> LocalListener {
            let served = dir.join("daemon.sock");
            let peer_path = dir.join("peer.sock");
            let peer = ipc::bind(&peer_path).expect("throwaway peer");
            let socket = Socket::new(Domain::UNIX, Type::STREAM, None).expect("socket");
            socket
                .bind(&SockAddr::unix(&served).expect("served address"))
                .expect("bind the served path");
            socket
                .connect(&SockAddr::unix(&peer_path).expect("peer address"))
                .expect("connect to the throwaway peer");
            drop(peer.accept().expect("peer accepts"));
            drop(peer);
            std::thread::sleep(Duration::from_millis(20));
            socket
                .listen(16)
                .expect("a disconnected socket may still listen");
            socket.into()
        }

        #[test]
        fn the_broken_listener_fails_like_the_reported_server() {
            let dir = tempfile::tempdir().expect("temp dir");
            let listener = broken_listener(dir.path());
            let error = listener
                .accept()
                .expect_err("a broken listener accepts nothing");
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionAborted);
        }

        #[test]
        fn a_listener_that_keeps_aborting_is_replaced_and_serves_again() {
            let dir = tempfile::tempdir().expect("temp dir");
            let path = dir.path().join("daemon.sock");
            let mut listener = ServerListener::new(path.clone(), broken_listener(dir.path()));

            let serving = std::thread::spawn(move || loop {
                let mut stream = listener.accept();
                // A connection taken off the broken socket before the swap
                // cannot be greeted; only the replacement's can.
                if stream.write_all(b"hello").is_err() {
                    continue;
                }
                let mut request = [0; 7];
                stream.read_exact(&mut request).expect("read the request");
                return request;
            });

            let deadline = Instant::now() + Duration::from_secs(10);
            let hello = loop {
                assert!(Instant::now() < deadline, "the listener was never replaced");
                let Ok(mut client) = ipc::connect(&path) else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                client
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("timeout");
                let mut hello = [0; 5];
                if client.read_exact(&mut hello).is_err() {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                client
                    .write_all(b"request")
                    .expect("the request reaches a working socket");
                break hello;
            };
            assert_eq!(&hello, b"hello");
            assert_eq!(&serving.join().expect("server thread"), b"request");
        }
    }
}
