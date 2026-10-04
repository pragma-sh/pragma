//! The hello frame names the exact server binary, so a desktop update that
//! ships a new `pragma-server` under an unchanged protocol is still detected.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use pragma_platform::ipc;
use pragma_protocol::{executable_build_id, read_json_frame, ServerFrame, PROTOCOL_VERSION};

#[test]
fn hello_carries_the_build_id_of_the_running_binary() {
    let dir = tempfile::tempdir().expect("temp dir");
    let channel = "hello-build-id-test";
    let binary = Path::new(env!("CARGO_BIN_EXE_pragma-server"));
    // An isolated server: its own app data directory and channel, run in the
    // foreground so this test owns (and kills) exactly this process.
    let mut server = Command::new(binary)
        .env("PRAGMA_APP_DATA_DIR", dir.path())
        .env("XDG_RUNTIME_DIR", dir.path())
        .env("PRAGMA_SERVER_CHANNEL", channel)
        .env("PRAGMA_DAEMON_CHANNEL", channel)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the server starts");
    let socket = ipc::socket_path_in(&dir.path().join(channel));

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut stream = loop {
        match ipc::connect(&socket) {
            Ok(stream) => break stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = server.kill();
                panic!("the server never listened at {}: {error}", socket.display());
            }
        }
    };
    // The socket accepts as soon as it is bound, but the hello is written only
    // once start-up reaches the accept loop — which a loaded Windows runner has
    // taken longer than 5s to do. Give it the same budget as the connect.
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .expect("read timeout");
    let frame = read_json_frame::<ServerFrame>(&mut stream);
    let _ = server.kill();
    let _ = server.wait();

    let ServerFrame::Hello(hello) = frame.expect("a hello frame") else {
        panic!("the first frame was not a hello");
    };
    assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
    assert_eq!(
        hello.build_id.as_deref(),
        Some(executable_build_id(binary).expect("hash").as_str())
    );
}
