//! `pragma-computer`: the native computer-use helper `pragma-server` spawns.
//!
//! It speaks the NDJSON protocol in `pragma_computer::protocol` on its
//! standard streams and exits when stdin closes. It is never run by hand;
//! `pragma-cli computer …` and `client.computer` are the interfaces.

use std::io::Write;
use std::path::PathBuf;

use pragma_computer::protocol::HelperHello;
use pragma_computer::{
    native_backend, platform_name, run_as_own_identity, serve::serve, Context, StopFlag,
};

fn main() {
    if let Some(code) = run_as_own_identity() {
        std::process::exit(code);
    }
    let screenshots_dir = std::env::args()
        .skip_while(|arg| arg != "--screenshots-dir")
        .nth(1)
        .map_or_else(std::env::temp_dir, PathBuf::from);
    let ctx = Context {
        stop: StopFlag::native(),
        screenshots_dir,
    };
    let hello = HelperHello {
        ready: true,
        pid: std::process::id(),
        platform: platform_name().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let mut stdout = std::io::stdout();
    if let Ok(line) = serde_json::to_string(&hello) {
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }
    let mut backend = native_backend();
    let stdin = std::io::BufReader::new(std::io::stdin());
    serve(backend.as_mut(), &ctx, stdin, stdout);
}
