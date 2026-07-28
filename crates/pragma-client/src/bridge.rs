//! Serving a local socket from an async byte stream.
//!
//! A bridge exposes a remote `pragma-server` as a local socket the synchronous
//! [`PragmaClient`](crate::PragmaClient) can connect to, exactly as if the
//! server were running on this machine. Two transports use it: the SSH
//! streamlocal bridge to a remote host, and the WSL bridge to a Linux server
//! running inside a WSL distribution.
//!
//! The awkward part is that the local side and the remote side live in
//! different worlds. The remote side is async — `russh` channels and child
//! process pipes are `tokio` streams. The local side is a blocking socket,
//! because on Windows `tokio` has no `AF_UNIX` support at all, so the listener
//! cannot be an async one. This module owns that seam: an accept loop on a
//! blocking thread, and per connection a pair of dedicated pump threads that
//! move bytes between the blocking socket and the async stream.
//!
//! Bytes are copied without any protocol awareness — framing stays entirely in
//! `pragma-protocol`.

use std::io::{Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};

use pragma_platform::ipc::{self, LocalListener, LocalStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// Chunk size for both directions of a bridged connection.
///
/// Matches the order of magnitude of a burst of PTY output, so a busy terminal
/// moves in a handful of reads rather than hundreds.
const PUMP_BUFFER_BYTES: usize = 32 * 1024;

/// How many chunks may be queued toward a pump thread before the producer waits.
///
/// Bounded on purpose: an unbounded queue would let a local client that stops
/// reading grow this process's memory without limit, which is the same failure
/// the server guards against with its write timeout.
const PUMP_QUEUE_DEPTH: usize = 64;

/// Binds the bridge's local socket, replacing any stale one left behind.
///
/// A socket file with nobody behind it is debris from a killed bridge; a socket
/// that still answers belongs to a live one and must not be evicted.
pub fn bind_local_socket(path: &Path) -> std::io::Result<LocalListener> {
    ipc::check_socket_path(path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        if ipc::connect(path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!("a bridge is already serving on {}", path.display()),
            ));
        }
        std::fs::remove_file(path)?;
    }
    ipc::bind(path)
}

/// Accepts one connection from a blocking listener without blocking the runtime.
///
/// The accept itself runs on a blocking thread; the listener is handed back
/// alongside the connection so the caller can loop.
pub async fn accept(listener: LocalListener) -> std::io::Result<(LocalStream, LocalListener)> {
    tokio::task::spawn_blocking(move || {
        let (stream, _addr) = listener.accept()?;
        Ok((stream, listener))
    })
    .await
    .map_err(|error| std::io::Error::other(error.to_string()))?
}

/// Copies bytes both ways between a blocking local socket and an async stream
/// until either side closes.
///
/// Each direction gets its own dedicated thread rather than a `spawn_blocking`
/// per chunk: the remote-to-local direction carries PTY output, and paying a
/// task dispatch for every burst of terminal output would show up as latency in
/// the terminal.
pub async fn pump<S>(local: LocalStream, remote: S) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (remote_reader, remote_writer) = tokio::io::split(remote);
    pump_split(local, remote_reader, remote_writer).await
}

/// [`pump`], for a remote whose halves are already separate.
///
/// A child process is the case that needs this: its stdout and stdin are two
/// distinct handles that cannot be recombined into one stream.
pub async fn pump_split<R, W>(
    local: LocalStream,
    mut remote_reader: R,
    mut remote_writer: W,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let local_reader = local.try_clone()?;
    let local_writer = local;

    // local -> remote: a blocking thread reads the socket and hands chunks to
    // the async side.
    let (up_tx, mut up_rx) = mpsc::channel::<Vec<u8>>(PUMP_QUEUE_DEPTH);
    let uplink = std::thread::spawn(move || {
        let mut reader = local_reader;
        let mut buffer = vec![0_u8; PUMP_BUFFER_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if up_tx.blocking_send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // remote -> local: the async side hands chunks to a blocking writer thread.
    let (down_tx, mut down_rx) = mpsc::channel::<Vec<u8>>(PUMP_QUEUE_DEPTH);
    let downlink = std::thread::spawn(move || {
        let mut writer = local_writer;
        while let Some(chunk) = down_rx.blocking_recv() {
            if writer.write_all(&chunk).is_err() {
                break;
            }
        }
        // Waking any reader still blocked on this socket is what lets the other
        // direction notice the connection is finished.
        let _ = writer.shutdown(Shutdown::Both);
    });

    let to_remote = async move {
        while let Some(chunk) = up_rx.recv().await {
            if remote_writer.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = remote_writer.shutdown().await;
    };

    let to_local = async move {
        let mut buffer = vec![0_u8; PUMP_BUFFER_BYTES];
        loop {
            match remote_reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if down_tx.send(buffer[..read].to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
        drop(down_tx);
    };

    tokio::join!(to_remote, to_local);
    let _ = uplink.join();
    let _ = downlink.join();
    Ok(())
}

/// Resolves the local socket path a bridge should expose for `name`.
///
/// Bridge sockets live beside the app's other per-channel state. The name is
/// kept short because a Unix-domain address has a hard length limit that a deep
/// Windows profile path can otherwise push it past.
#[must_use]
pub fn bridge_socket_path(state_dir: &Path, name: &str) -> PathBuf {
    state_dir.join(format!("{name}.sock"))
}

#[cfg(test)]
mod tests {
    use super::{bind_local_socket, bridge_socket_path, pump};
    use std::io::{Read, Write};
    use std::path::Path;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_bridge_socket_is_named_inside_the_state_directory() {
        assert_eq!(
            bridge_socket_path(Path::new("/state"), "wsl-ubuntu"),
            Path::new("/state").join("wsl-ubuntu.sock")
        );
    }

    /// A socket file left behind by a killed bridge must not block the next
    /// bridge from starting — that would make a crash require manual cleanup.
    #[test]
    fn a_stale_socket_file_is_replaced() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bridge.sock");
        std::fs::write(&path, b"debris from a killed bridge").expect("seed a stale socket file");

        let listener = bind_local_socket(&path).expect("a stale socket file must not block a bind");
        drop(listener);
    }

    /// The bridge is a byte pipe: whatever the remote sends must arrive at the
    /// local socket unchanged and in order, since `pragma-protocol` framing sits
    /// on top of it.
    #[test]
    fn bytes_flow_both_ways_through_the_pump() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bridge.sock");
        let listener = bind_local_socket(&path).expect("bind");

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");

        // Stand in for the remote side with an in-memory duplex stream.
        let (remote_end, bridge_end) = tokio::io::duplex(64 * 1024);

        let accepted = std::thread::spawn(move || listener.accept().expect("accept").0);
        let mut client = pragma_platform::ipc::connect(&path).expect("connect");
        let server_side = accepted.join().expect("accept thread");

        runtime.spawn(async move {
            let _ = pump(server_side, bridge_end).await;
        });

        runtime.block_on(async move {
            let (mut remote_reader, mut remote_writer) = tokio::io::split(remote_end);

            // local -> remote
            let write = std::thread::spawn(move || {
                client.write_all(b"from-local").expect("local write");
                let mut received = [0_u8; 11];
                client.read_exact(&mut received).expect("local read");
                assert_eq!(&received, b"from-remote");
            });

            let mut received = [0_u8; 10];
            remote_reader
                .read_exact(&mut received)
                .await
                .expect("remote read");
            assert_eq!(&received, b"from-local");

            // remote -> local
            remote_writer
                .write_all(b"from-remote")
                .await
                .expect("remote write");

            tokio::task::spawn_blocking(move || write.join().expect("local thread"))
                .await
                .expect("join");
        });
    }
}
