//! Process resource limits shared by every Pragma host process.
//!
//! macOS launches GUI apps through `launchd`, whose default `RLIMIT_NOFILE`
//! soft limit is **256**. That limit is inherited by everything Pragma spawns —
//! `pragma-server`, the gateway, sidecars, and every shell running inside a
//! terminal tab. Rust (unlike Node/Bun) never raises the soft limit on its own,
//! so a busy session exhausts it and the server starts failing `accept()` with
//! `EMFILE` ("Too many open files") while tests running inside tabs hit the same
//! ceiling. Every host process therefore raises the soft limit to the hard limit
//! before it opens anything.

/// Soft `RLIMIT_NOFILE` every Pragma host process asks for at startup.
///
/// The effective value is capped at the hard limit, so this is a ceiling
/// request rather than a guarantee: macOS caps a process at
/// `kern.maxfilesperproc` (122 880 by default), typical Linux hard limits are
/// 524 288 or higher.
const DESIRED_NOFILE: u64 = 65_536;

/// Raises this process's open-file soft limit toward [`DESIRED_NOFILE`],
/// returning the soft limit now in effect.
///
/// Only ever raises: a process that already has a *higher* soft limit — a `cargo
/// test` run from a configured login shell, say — keeps it, so the returned
/// value can exceed [`DESIRED_NOFILE`]. In the other direction it is capped at
/// the hard limit.
///
/// Best-effort by design: a platform that refuses the raise still runs, just
/// with the inherited ceiling, so callers log rather than abort. Must be called
/// before spawning children — they inherit the limit in force at `fork` time.
///
/// Windows has no `RLIMIT_NOFILE`. Its equivalent ceiling is the C runtime's
/// stdio descriptor table, which `rlimit` raises with `_setmaxstdio`, and it is
/// per-process rather than inherited — so children raise their own. Sockets do
/// not draw on it at all, which is why Windows does not see the `EMFILE`
/// failure this exists to prevent.
pub fn raise_open_file_limit() -> std::io::Result<u64> {
    rlimit::increase_nofile_limit(DESIRED_NOFILE)
}

// The test below reads the limit pair directly, which only exists on Unix;
// `raise_open_file_limit` itself is available on every platform.
#[cfg(all(test, unix))]
mod tests {
    use super::{raise_open_file_limit, DESIRED_NOFILE};

    /// The contract is "never end up below what we asked for, and never below
    /// where we started" — not "end up at exactly `DESIRED_NOFILE`". The test
    /// process inherits its soft limit from whatever launched it, which in a
    /// login shell is routinely far above the launchd default this exists to
    /// escape.
    #[test]
    fn raises_the_soft_limit_to_at_least_the_request() {
        let (before, hard) = rlimit::Resource::NOFILE
            .get()
            .expect("reading the current NOFILE limits succeeds");

        let after = raise_open_file_limit().expect("raising the soft limit succeeds");

        assert!(
            after >= before,
            "soft limit went backwards: {before} -> {after}",
        );
        assert!(
            after >= DESIRED_NOFILE.min(hard),
            "soft limit {after} is below the requested {DESIRED_NOFILE} (hard limit {hard})",
        );
        assert!(
            after > 256,
            "soft limit {after} is still at or below the launchd default of 256",
        );
    }
}
