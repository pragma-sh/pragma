//! Local IPC transport: the socket the server binds and native clients connect to.
//!
//! Pragma speaks one transport on every supported platform — a Unix-domain
//! stream socket addressed by a filesystem path. macOS and Linux get it from
//! `std`; Windows gets it from `uds_windows`, which wraps the `AF_UNIX` support
//! Windows has shipped since build 17063 (Windows 10 1803). Note this is *not*
//! the app's minimum Windows version — `ConPTY` sets a higher floor; see the
//! table in this crate's `AGENTS.md`. Both expose the
//! same surface — `connect`, `try_clone`, `shutdown`, `pair`, and read/write
//! timeouts — so the framing and blocking behaviour in `pragma-protocol` and
//! the server's client loop are identical everywhere and the wire format is
//! untouched.
//!
//! Windows named pipes were the alternative. They were not chosen because they
//! have neither read timeouts nor a socket-style `shutdown`, both of which this
//! codebase depends on: the server wakes a blocked reader by shutting the
//! socket down from another thread. Emulating that over named pipes means
//! overlapped I/O and `CancelIoEx`, which needs `unsafe` — forbidden across
//! this workspace — for no behavioural gain on a local-only transport.

use std::io;
use std::path::{Path, PathBuf};

use pragma_constants::CONSTANTS;

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as LocalListener, UnixStream as LocalStream};

#[cfg(windows)]
pub use uds_windows::{UnixListener as LocalListener, UnixStream as LocalStream};

/// Largest socket path the operating system will accept.
///
/// A Unix-domain address carries its path inside a fixed `sun_path` buffer, and
/// Windows uses the same 108-byte buffer as Linux. Overrunning it produces an
/// opaque OS error at bind or connect time, so [`check_socket_path`] turns it
/// into a message that names the real problem.
///
/// The limit counts bytes, not characters, and one byte is reserved for the
/// terminating NUL.
pub const MAX_SOCKET_PATH_BYTES: usize = 107;

/// Names of the files the server keeps in its server directory.
///
/// These come from `@pragma/constants` so the Rust server, the Rust client, and
/// the TypeScript frontend cannot drift apart on what the socket is called.
#[must_use]
pub fn socket_file_name() -> &'static str {
    &CONSTANTS.daemon.socket_file
}

/// Name of the server's startup lock file.
#[must_use]
pub fn lock_file_name() -> &'static str {
    &CONSTANTS.daemon.lock_file
}

/// Name of the file the detached server writes its output to.
#[must_use]
pub fn log_file_name() -> &'static str {
    &CONSTANTS.daemon.log_file
}

/// Resolves the socket path inside a server directory.
#[must_use]
pub fn socket_path_in(server_dir: &Path) -> PathBuf {
    server_dir.join(socket_file_name())
}

/// Resolves the lock path inside a server directory.
#[must_use]
pub fn lock_path_in(server_dir: &Path) -> PathBuf {
    server_dir.join(lock_file_name())
}

/// Resolves the log path inside a server directory.
#[must_use]
pub fn log_path_in(server_dir: &Path) -> PathBuf {
    server_dir.join(log_file_name())
}

/// Rejects a socket path the operating system could not address.
///
/// Call this before binding or connecting so an over-long path fails with an
/// explanation instead of a bare `InvalidInput` from the socket layer. Deeply
/// nested Windows profile directories are the realistic way to hit this.
pub fn check_socket_path(path: &Path) -> io::Result<()> {
    let len = path.as_os_str().as_encoded_bytes().len();
    if len > MAX_SOCKET_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "socket path is {len} bytes, over the {MAX_SOCKET_PATH_BYTES}-byte limit \
                 the operating system allows for a Unix-domain address: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// Binds a listener at `path`, after checking the path is addressable.
///
/// The caller is responsible for clearing a stale socket file first — a bind
/// over an existing path fails on every platform, and deleting one blindly
/// would evict a server that is still serving.
pub fn bind(path: &Path) -> io::Result<LocalListener> {
    check_socket_path(path)?;
    let listener = LocalListener::bind(path)?;
    perms_after_bind(path)?;
    Ok(listener)
}

/// Connects to a server listening at `path`.
pub fn connect(path: &Path) -> io::Result<LocalStream> {
    check_socket_path(path)?;
    LocalStream::connect(path)
}

/// Restricts a freshly bound socket to its owner.
///
/// On Unix this is the `0600` mode the server has always applied. On Windows
/// the socket is a real filesystem entry, so the same owner-only access control
/// list used for token files applies to it.
fn perms_after_bind(path: &Path) -> io::Result<()> {
    crate::perms::restrict_to_owner(path)
}

#[cfg(test)]
mod tests {
    use super::{
        check_socket_path, lock_file_name, log_file_name, socket_file_name, socket_path_in,
        MAX_SOCKET_PATH_BYTES,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn server_file_names_come_from_shared_constants() {
        assert_eq!(socket_file_name(), "daemon.sock");
        assert_eq!(lock_file_name(), "server.lock");
        assert_eq!(log_file_name(), "server.log");
    }

    #[test]
    fn socket_path_is_resolved_inside_the_server_directory() {
        let dir = Path::new("server-dir");
        assert_eq!(
            socket_path_in(dir),
            PathBuf::from("server-dir").join("daemon.sock")
        );
    }

    #[test]
    fn a_short_socket_path_is_addressable() {
        assert!(check_socket_path(Path::new("/tmp/pragma/daemon.sock")).is_ok());
    }

    /// The failure this guards against is a long Windows profile directory
    /// pushing the socket past `sun_path`. Without the check the user sees an
    /// unexplained `InvalidInput` from bind; with it they see the path length.
    #[test]
    fn an_over_long_socket_path_is_rejected_with_a_readable_reason() {
        let long = PathBuf::from("/".to_string() + &"x".repeat(MAX_SOCKET_PATH_BYTES));
        let error = check_socket_path(&long).expect_err("a path over the limit must not be used");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        let message = error.to_string();
        assert!(
            message.contains(&MAX_SOCKET_PATH_BYTES.to_string()),
            "the error must name the limit it broke, got: {message}"
        );
    }

    #[test]
    fn a_path_exactly_at_the_limit_is_accepted() {
        let exact = PathBuf::from("/".to_string() + &"x".repeat(MAX_SOCKET_PATH_BYTES - 1));
        assert_eq!(exact.as_os_str().len(), MAX_SOCKET_PATH_BYTES);
        assert!(check_socket_path(&exact).is_ok());
    }
}
