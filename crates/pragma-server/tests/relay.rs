//! End-to-end cover for `pragma-server --relay`, the stdio relay a Windows
//! client runs inside a WSL distribution to reach the Linux server there.
//!
//! `wsl.exe` is the only Windows-specific part of that path; the relay itself
//! is ordinary Unix code, so it is exercised here on the host directly. What
//! matters is that bytes cross in both directions unchanged and that closing
//! one side tears the other down — the relay carries `pragma-protocol` frames
//! and must not reorder, merge-corrupt, or truncate them.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use pragma_platform::ipc;

/// Points a relay child at `dir` as its server directory.
///
/// The server resolves its socket from the app data directory and channel, and
/// prefers `XDG_RUNTIME_DIR` on Linux, so all three are set.
fn relay_command(dir: &std::path::Path, channel: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pragma-server"));
    command
        .arg("--relay")
        .env("PRAGMA_APP_DATA_DIR", dir)
        .env("XDG_RUNTIME_DIR", dir)
        .env("PRAGMA_SERVER_CHANNEL", channel)
        .env("PRAGMA_DAEMON_CHANNEL", channel)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn the_relay_carries_bytes_between_stdio_and_the_server_socket() {
    let dir = tempfile::tempdir().expect("temp dir");
    let channel = "relay-test";
    let server_dir = dir.path().join(channel);
    std::fs::create_dir_all(&server_dir).expect("server dir");
    let socket = ipc::socket_path_in(&server_dir);

    let listener = ipc::bind(&socket).expect("a server socket is bindable");
    // Stand in for the server: uppercase whatever arrives, so the bytes coming
    // back are provably the ones that went through the socket.
    let serving = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buffer = [0_u8; 64];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let echoed: Vec<u8> = buffer[..read].to_ascii_uppercase();
                    if stream.write_all(&echoed).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut child = relay_command(dir.path(), channel)
        .spawn()
        .expect("the relay starts");
    let mut stdin = child.stdin.take().expect("relay stdin");
    let mut stdout = child.stdout.take().expect("relay stdout");

    stdin.write_all(b"hello").expect("write into the relay");
    stdin.flush().expect("flush");

    let mut received = [0_u8; 5];
    stdout
        .read_exact(&mut received)
        .expect("the server's reply comes back out of the relay");
    assert_eq!(&received, b"HELLO");

    // Closing the client side must end the relay rather than leave it resident.
    drop(stdin);
    let status = child.wait().expect("the relay exits when its input closes");
    assert!(status.success(), "the relay exited with {status}");
    serving.join().expect("the fake server thread finishes");
}

/// A relay pointed at a socket nobody is serving must fail loudly. Exiting
/// successfully would make a failed bridge look like an empty terminal.
#[test]
fn the_relay_fails_when_no_server_is_listening() {
    let dir = tempfile::tempdir().expect("temp dir");
    let output = relay_command(dir.path(), "absent-server")
        .spawn()
        .expect("the relay starts")
        .wait_with_output()
        .expect("the relay exits");

    assert!(
        !output.status.success(),
        "a relay with no server behind it must not report success"
    );
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(
        message.contains("relay could not reach the server"),
        "the failure must name the unreachable server, got: {message}"
    );
}
