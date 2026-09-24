//! Keeping the machine awake while Pragma is serving a remote client.
//!
//! Each platform exposes the "don't sleep" request differently, and every one of
//! them ties the request to the lifetime of whoever made it. Rather than calling
//! those APIs through FFI (the workspace forbids `unsafe`), an inhibitor here is
//! a small child process that holds the request on our behalf:
//!
//! - **macOS** — `caffeinate -i -s`, which takes the idle- and system-sleep
//!   power assertions. macOS still sleeps on lid close without an external
//!   display; only `pmset disablesleep` (root) overrides that.
//! - **Linux** — `systemd-inhibit` with `sleep:idle:handle-lid-switch`, so
//!   logind also ignores the lid switch. Active local sessions are allowed to
//!   take these locks by the default polkit policy.
//! - **Windows** — a PowerShell process that calls `SetThreadExecutionState`
//!   with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`. The lid action is a power-plan
//!   setting, which this deliberately does not rewrite.
//!
//! Every helper also watches the process that spawned it and exits when that
//! process does, so a crashed server never leaves the machine pinned awake.

use std::process::{Child, Command, Stdio};

use crate::process::command;

/// A held request to keep the system awake; released when dropped.
#[derive(Debug)]
pub struct SleepInhibitor {
    child: Child,
}

impl SleepInhibitor {
    /// Starts holding the system awake until this value is dropped or the
    /// current process exits. `reason` is shown where the OS lists inhibitors.
    ///
    /// # Errors
    ///
    /// Returns an error when the platform helper cannot be spawned (for
    /// example, `systemd-inhibit` is absent on a non-systemd Linux).
    pub fn acquire(reason: &str) -> std::io::Result<Self> {
        let child = inhibitor_command(reason, std::process::id())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Self { child })
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(target_os = "macos")]
fn inhibitor_command(_reason: &str, owner: u32) -> Command {
    let mut cmd = command("/usr/bin/caffeinate");
    cmd.args(["-i", "-s", "-w", &owner.to_string()]);
    cmd
}

#[cfg(all(unix, not(target_os = "macos")))]
fn inhibitor_command(reason: &str, owner: u32) -> Command {
    let mut cmd = command("systemd-inhibit");
    cmd.args([
        "--what=sleep:idle:handle-lid-switch",
        "--who=Pragma",
        &format!("--why={reason}"),
        "--mode=block",
        "sh",
        "-c",
        // Portable stand-in for `tail --pid`, which busybox lacks.
        &format!("while kill -0 {owner} 2>/dev/null; do sleep 5; done"),
    ]);
    cmd
}

#[cfg(windows)]
fn inhibitor_command(_reason: &str, owner: u32) -> Command {
    // 2147483649 = ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1). The
    // state belongs to the calling thread, so `Wait-Process` blocks that same
    // thread for as long as the request should hold.
    let script = format!(
        "$k = Add-Type -Name Power -Namespace Pragma -PassThru -MemberDefinition \
         '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; \
         [void]$k::SetThreadExecutionState([uint32]2147483649); \
         Wait-Process -Id {owner}"
    );
    let mut cmd = command("powershell.exe");
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &script,
    ]);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn helper_watches_its_owner() {
        let cmd = inhibitor_command("test", 4242);
        assert!(args(&cmd).iter().any(|arg| arg.contains("4242")));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_helper_blocks_the_lid_switch() {
        let cmd = inhibitor_command("test", 1);
        assert!(args(&cmd).contains(&"--what=sleep:idle:handle-lid-switch".to_string()));
    }

    #[test]
    fn released_on_drop() {
        // Not every CI image has the helper (no systemd in a container); the
        // spawn contract is what is under test, so skip when it is missing.
        let Ok(inhibitor) = SleepInhibitor::acquire("pragma-platform test") else {
            return;
        };
        let pid = inhibitor.child.id();
        drop(inhibitor);
        assert!(!crate::process::is_running(pid, ""));
    }
}
