//! User-initiated desktop navigation, without synthetic input or agent leases.

use std::io;

/// Brings an existing application's window forward by process id.
///
/// This is desktop-user navigation, not authorization for agent input. Callers
/// must resolve the pid from trusted host state rather than an agent's payload.
pub fn focus_app(pid: u64) -> io::Result<()> {
    let pid = i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid application pid"))?;
    focus_pid(pid)
}

#[cfg(target_os = "macos")]
fn focus_pid(pid: i32) -> io::Result<()> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .filter(|app| !app.isTerminated())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "application is no longer running")
        })?;
    if app.isHidden() {
        app.unhide();
    }
    // Match the helper's explicit user-requested activation on pre-14 macOS too.
    #[allow(deprecated)]
    let options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    if app.activateWithOptions(options) {
        Ok(())
    } else {
        Err(io::Error::other("the application refused focus"))
    }
}

#[cfg(windows)]
fn focus_pid(pid: i32) -> io::Result<()> {
    let status = crate::process::command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$app = New-Object -ComObject WScript.Shell; if (-not $app.AppActivate([int]$env:PRAGMA_FOCUS_PID)) { exit 1 }",
        ])
        .env("PRAGMA_FOCUS_PID", pid.to_string())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            "the application refused focus or is no longer running",
        ))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn focus_pid(_pid: i32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "computer-use app navigation is not supported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_process_ids_never_reach_the_desktop() {
        for pid in [0, i32::MAX as u64 + 1, u64::MAX] {
            assert_eq!(
                focus_app(pid).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }
}
