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
/// These come from `@pragma-sh/constants` so the Rust server, the Rust client, and
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
/// Owner-only access is enforced on the socket's **directory**, which is made
/// owner-only (`0700`, or an owner-only inheritable ACL on Windows) *before*
/// the bind, so the socket is never reachable by another account even for an
/// instant. That directory must therefore belong to the socket; binding
/// directly inside the shared temporary directory is refused.
///
/// The socket entry itself is never opened as a file. On Windows an `AF_UNIX`
/// socket is a reparse point that no filesystem filter handles, so following it
/// — `std::fs::metadata` on older toolchains, `icacls`, any ordinary open —
/// fails with `ERROR_CANT_ACCESS_FILE` (1920). It does not need its own ACL:
/// it is created with the one it inherits from the private directory. On Unix
/// the socket is additionally narrowed to `0600`, which `chmod` can do without
/// opening it.
///
/// The caller is responsible for clearing a stale socket first — see
/// [`remove_stale_socket`]. A bind over an existing path fails on every
/// platform, and deleting one blindly would evict a server that is still
/// serving. If anything after the bind fails, the socket just created is
/// removed again, so a failed start never leaves debris behind.
pub fn bind(path: &Path) -> io::Result<LocalListener> {
    check_socket_path(path)?;
    let dir = socket_dir(path)?;
    refuse_shared_dir(dir)?;
    crate::perms::create_private_dir(dir)?;
    let listener = LocalListener::bind(path)?;
    if let Err(error) = narrow_socket(path) {
        drop(listener);
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(listener)
}

/// Connects to a server listening at `path`.
pub fn connect(path: &Path) -> io::Result<LocalStream> {
    check_socket_path(path)?;
    LocalStream::connect(path)
}

/// Reports whether a filesystem entry exists at a socket path.
///
/// `Path::exists` is the wrong question for a socket: it follows the entry,
/// and on Windows following an `AF_UNIX` reparse point can fail with
/// `ERROR_CANT_ACCESS_FILE`, which `exists` reports as "absent". A stale socket
/// then survives every restart and each bind over it fails with
/// `WSAEINVAL` (10022). This looks at the entry itself instead.
pub fn socket_entry_exists(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Clears a socket path for binding, refusing if something still serves on it.
///
/// A socket file with nobody behind it is debris from a killed process and is
/// deleted; a socket that still accepts a connection belongs to a live server
/// and is left alone, reported as [`io::ErrorKind::AddrInUse`]. Deletion works
/// on a Windows socket reparse point because `remove_file` is `DeleteFileW`,
/// which removes the reparse point itself rather than following it.
pub fn remove_stale_socket(path: &Path) -> io::Result<()> {
    if !socket_entry_exists(path)? {
        return Ok(());
    }
    if connect(path).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("something is already serving on {}", path.display()),
        ));
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io::Error::new(
            error.kind(),
            format!("could not remove stale socket {}: {error}", path.display()),
        )),
    }
}

/// The directory a socket lives in, which [`bind`] makes owner-only.
fn socket_dir(path: &Path) -> io::Result<&Path> {
    path.parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "socket path {} has no directory of its own to restrict",
                    path.display()
                ),
            )
        })
}

/// Refuses to make the shared temporary directory owner-only.
///
/// On Windows that would strip `SYSTEM` and Administrators from the user's
/// whole `%TEMP%`; on Linux `/tmp` is not ours to `chmod`. A socket that wants
/// to live under the temporary directory gets a subdirectory of its own.
fn refuse_shared_dir(dir: &Path) -> io::Result<()> {
    let temp = std::env::temp_dir();
    let same = match (
        crate::path::canonicalize(dir),
        crate::path::canonicalize(&temp),
    ) {
        (Ok(dir), Ok(temp)) => dir == temp,
        _ => dir == temp,
    };
    if same {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to bind a socket directly in the shared temporary directory {}; \
                 give it a directory of its own",
                dir.display()
            ),
        ));
    }
    Ok(())
}

/// Narrows a freshly bound socket on top of its private directory.
///
/// Unix: `0600` on the socket node (`chmod` never opens it). Windows has no
/// per-entry step to take: the socket's reparse point cannot be opened to
/// change its ACL, and it already carries the owner-only ACL it inherited from
/// the directory [`bind`] restricted before creating it — that inheritance *is*
/// the Windows implementation of this guarantee, not an omission of it.
fn narrow_socket(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(windows)]
    {
        // Confirm the entry exists without following it, so a bind that
        // somehow produced nothing is still an error rather than a no-op.
        socket_entry_exists(path).and_then(|exists| {
            if exists {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("bound socket {} is missing", path.display()),
                ))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bind, check_socket_path, connect, lock_file_name, log_file_name, remove_stale_socket,
        socket_entry_exists, socket_file_name, socket_path_in, MAX_SOCKET_PATH_BYTES,
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

    /// The Windows regression (#212): binding succeeded, then the post-bind
    /// owner-only step opened the socket as a file and failed with 1920. A bind
    /// must succeed and hand back a listener that accepts.
    #[test]
    fn a_bound_socket_accepts_a_connection() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("server").join("daemon.sock");
        let listener = bind(&path).expect("binding into a fresh directory succeeds");
        let accepted = std::thread::spawn(move || listener.accept().map(|_| ()));
        connect(&path).expect("a client can connect");
        accepted
            .join()
            .expect("accept thread")
            .expect("the listener accepts");
    }

    /// `Path::exists` follows the entry, which on Windows reports a live
    /// `AF_UNIX` socket as absent — the reason a stale socket was never cleared.
    #[test]
    fn a_bound_socket_is_seen_as_an_existing_entry() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("daemon.sock");
        assert!(!socket_entry_exists(&path).expect("probe"));
        let _listener = bind(&path).expect("bind");
        assert!(socket_entry_exists(&path).expect("probe"));
    }

    /// A socket left behind by a process that died (here: a dropped listener,
    /// which leaves the entry on every platform) is removed so a restart can
    /// bind again, instead of failing with `WSAEINVAL`/`EADDRINUSE` forever.
    #[test]
    fn a_dead_socket_is_removed_and_the_path_rebinds() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("daemon.sock");
        drop(bind(&path).expect("first bind"));
        assert!(
            socket_entry_exists(&path).expect("probe"),
            "a closed listener leaves its socket entry behind"
        );

        remove_stale_socket(&path).expect("a socket nobody answers on is stale");
        assert!(!socket_entry_exists(&path).expect("probe"));
        let _listener = bind(&path).expect("the path is bindable again");
    }

    #[test]
    fn a_live_socket_is_not_removed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("daemon.sock");
        let _listener = bind(&path).expect("bind");

        let error = remove_stale_socket(&path).expect_err("a serving socket must be kept");
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
        assert!(socket_entry_exists(&path).expect("probe"));
    }

    #[test]
    fn clearing_a_missing_socket_is_a_no_op() {
        let dir = tempfile::tempdir().expect("temp dir");
        remove_stale_socket(&dir.path().join("daemon.sock")).expect("nothing to clear");
    }

    /// Making the socket's directory owner-only is how the guarantee is kept,
    /// so the shared temporary directory must never be that directory.
    #[test]
    fn binding_directly_in_the_temp_dir_is_refused() {
        let path =
            std::env::temp_dir().join(format!("pragma-ipc-test-{}.sock", std::process::id()));
        let error = bind(&path).expect_err("the shared temp dir is not ours to restrict");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(
            !socket_entry_exists(&path).expect("probe"),
            "nothing was bound"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_and_its_directory_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp dir");
        let server_dir = dir.path().join("server");
        std::fs::create_dir(&server_dir).expect("dir");
        std::fs::set_permissions(&server_dir, std::fs::Permissions::from_mode(0o755))
            .expect("loosen the directory so the tightening is observable");
        let path = server_dir.join("daemon.sock");
        let _listener = bind(&path).expect("bind");

        let mode = |p: &Path| std::fs::metadata(p).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode(&server_dir), 0o700);
        assert_eq!(mode(&path), 0o600);
    }

    /// On Windows the owner-only ACL is set on the directory before the bind
    /// and inherited by the socket. Read it back with `icacls` (read-only, on
    /// the directory — never on the socket, which `icacls` cannot open).
    #[cfg(windows)]
    #[test]
    fn the_socket_directory_grants_only_its_owner() {
        let dir = tempfile::tempdir().expect("temp dir");
        let server_dir = dir.path().join("server");
        let _listener = bind(&server_dir.join("daemon.sock")).expect("bind");

        let output = crate::process::command("icacls")
            .arg(&server_dir)
            .output()
            .expect("icacls runs");
        assert!(output.status.success());
        let acl = String::from_utf8_lossy(&output.stdout);
        let user = std::env::var("USERNAME").expect("USERNAME");
        assert!(acl.contains(&user), "the owner is granted access: {acl}");
        for broad in ["Everyone", "BUILTIN\\Users", "Authenticated Users"] {
            assert!(!acl.contains(broad), "{broad} must not be granted: {acl}");
        }
    }
}
