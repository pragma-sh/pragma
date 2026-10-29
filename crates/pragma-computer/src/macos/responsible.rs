//! Making the helper its own TCC identity.
//!
//! macOS checks Accessibility and Screen Recording against the *responsible*
//! process, which a plain binary inherits from whatever app started the
//! chain — the dev app, or the terminal app that ran `bun run dev`. So the
//! helper re-runs itself with responsibility disclaimed, and the grants in
//! System Settings attach to `pragma-computer` itself. The original process
//! only waits; the disclaimed child exits as soon as it is orphaned, so a
//! supervisor that kills the outer pid still stops every native call.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::time::Duration;

use super::ffi;

/// Set on the disclaimed child so it does not re-run itself again.
const DISCLAIMED_ENV: &str = "PRAGMA_COMPUTER_DISCLAIMED";
/// How often the disclaimed child checks that its waiting parent is alive.
const PARENT_POLL: Duration = Duration::from_millis(50);

/// Re-runs this helper as its own responsible process.
///
/// Returns the child's exit code once it ends, for the caller to exit with,
/// or `None` when this process should serve itself: it already is the
/// disclaimed child, or disclaiming failed (the helper then runs with the
/// inherited identity, as before).
pub fn run_as_own_identity() -> Option<i32> {
    if std::env::var_os(DISCLAIMED_ENV).is_some() {
        exit_when_orphaned();
        return None;
    }
    let program = CString::new(std::env::current_exe().ok()?.as_os_str().as_bytes()).ok()?;
    let args: Vec<CString> = std::env::args_os()
        .filter_map(|arg| CString::new(arg.as_bytes()).ok())
        .collect();
    let mut env: Vec<CString> = std::env::vars_os()
        .filter_map(|(key, value)| {
            let mut pair = key.as_bytes().to_vec();
            pair.push(b'=');
            pair.extend_from_slice(value.as_bytes());
            CString::new(pair).ok()
        })
        .collect();
    env.push(CString::new(format!("{DISCLAIMED_ENV}=1")).ok()?);
    match ffi::run_disclaimed(&program, &args, &env) {
        Ok(code) => Some(code),
        Err(errno) => {
            eprintln!("pragma-computer: could not disclaim responsibility (errno {errno})");
            None
        }
    }
}

/// Exits this process once its parent is gone (it is reparented to launchd).
fn exit_when_orphaned() {
    let parent = std::os::unix::process::parent_id();
    std::thread::spawn(move || loop {
        if std::os::unix::process::parent_id() != parent {
            std::process::exit(1);
        }
        std::thread::sleep(PARENT_POLL);
    });
}
