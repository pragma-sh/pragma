//! Running the session's own `pragma-cli`, not whichever one `PATH` found.
//!
//! A Pragma terminal exports `PRAGMA_CLI` — the helper built for the server
//! that spawned it — and prepends its directory to `PATH`. A login shell's rc
//! file can then prepend another directory (commonly `~/.local/bin`, where the
//! release app installs its helper), so a bare `pragma-cli` in a dev or
//! second-channel tab resolves to a CLI from a different release and every
//! server call fails with a protocol mismatch. Re-running the exported binary
//! makes the session's server and CLI agree regardless of shell config.

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

/// The binary a Pragma session exported for itself.
const SESSION_CLI_ENV: &str = "PRAGMA_CLI";
/// Set on the delegated child so it never delegates again.
const DELEGATED_ENV: &str = "PRAGMA_CLI_DELEGATED";

/// Runs `$PRAGMA_CLI` with this process's arguments when it is a different
/// binary from this one, returning its exit code. `None` means run here:
/// outside a Pragma session, already delegated, already the session's CLI,
/// or the exported binary could not be started.
pub fn delegate() -> Option<ExitCode> {
    if std::env::var_os(DELEGATED_ENV).is_some() {
        return None;
    }
    let target = std::env::var_os(SESSION_CLI_ENV).filter(|value| !value.is_empty())?;
    let current = std::env::current_exe().ok()?;
    if !is_other_binary(Path::new(&target), &current) {
        return None;
    }
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let status = pragma_platform::process::command(&target)
        .args(args)
        .env(DELEGATED_ENV, "1")
        .status()
        .ok()?;
    Some(status.code().map_or(ExitCode::FAILURE, |code| {
        ExitCode::from(u8::try_from(code).unwrap_or(1))
    }))
}

/// True when `target` exists and resolves to a different file than `current`.
fn is_other_binary(target: &Path, current: &Path) -> bool {
    let Ok(target) = pragma_platform::path::canonicalize(target) else {
        return false;
    };
    pragma_platform::path::canonicalize(current).map_or(true, |current| current != target)
}

#[cfg(test)]
mod tests {
    use super::is_other_binary;

    #[test]
    fn same_file_is_not_another_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("pragma-cli");
        std::fs::write(&file, b"").expect("write");
        assert!(!is_other_binary(&file, &file));
    }

    #[test]
    fn different_file_is_another_binary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = dir.path().join("a");
        let second = dir.path().join("b");
        std::fs::write(&first, b"").expect("write");
        std::fs::write(&second, b"").expect("write");
        assert!(is_other_binary(&first, &second));
    }

    #[test]
    fn missing_target_is_never_delegated_to() {
        let dir = tempfile::tempdir().expect("tempdir");
        let current = dir.path().join("current");
        std::fs::write(&current, b"").expect("write");
        assert!(!is_other_binary(&dir.path().join("missing"), &current));
    }
}
