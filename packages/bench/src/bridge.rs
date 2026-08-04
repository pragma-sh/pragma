//! Finding the dev bridge of the app the benchmark launched.
//!
//! Split out because it is needed twice, at two different moments: once at
//! start-up, and again whenever the app is replaced underneath a run. Tauri's
//! dev watcher restarts the app when a watched source file changes, and
//! `bun run dev` regenerates `packages/constants` — which is watched — on its
//! way up. So a benchmark that resolved the app's pid once and kept it would be
//! talking to a dead process within the first minute of a normal run.
//!
//! Identity is "a bridge whose process descends from the `bun run dev` we
//! spawned". That survives a restart (the replacement is also a descendant) and
//! still never adopts another developer's window.

use std::fs;
use std::io::ErrorKind;

use serde::Deserialize;

use crate::error::BenchResult;

/// Where the dev bridge writes its token files. Hard-coded to `/tmp` by
/// `dev_bridge.rs`; the benchmark cannot be more portable than the bridge it
/// drives, and refuses to run on Windows for this reason.
const TOKEN_DIR: &str = "/tmp";
const TOKEN_PREFIX: &str = "tauri-dev-bridge-";
const TOKEN_SUFFIX: &str = ".token";

/// What the bridge publishes about itself once it is listening.
///
/// Only the pid is used: the CLI takes `--pid` and rediscovers the port and
/// token itself, so mirroring those here would be a second source of truth.
#[derive(Debug, Clone, Deserialize)]
pub struct BridgeToken {
    pub pid: u32,
}

/// Every bridge token currently on disk.
pub fn tokens() -> BenchResult<Vec<BridgeToken>> {
    let mut tokens = Vec::new();
    let entries = match fs::read_dir(TOKEN_DIR) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(tokens),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(TOKEN_PREFIX) || !name.ends_with(TOKEN_SUFFIX) {
            continue;
        }
        let Ok(contents) = fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Ok(token) = serde_json::from_str::<BridgeToken>(&contents) {
            tokens.push(token);
        }
    }
    Ok(tokens)
}

/// The bridge belonging to `dev_pid`'s process tree, ignoring `exclude` (the
/// bridges that were already listening before the benchmark started anything).
pub fn locate(dev_pid: u32, exclude: &[u32]) -> Option<BridgeToken> {
    tokens()
        .ok()?
        .into_iter()
        .find(|token| !exclude.contains(&token.pid) && is_descendant(token.pid, dev_pid))
}

/// Whether `pid` descends from `ancestor`, walking the live process table.
pub fn is_descendant(pid: u32, ancestor: u32) -> bool {
    let Ok(processes) = pragma_platform::process::list_processes() else {
        return false;
    };
    let mut current = pid;
    // Bounded so a corrupt table (or a pid reused as its own ancestor) cannot
    // spin here forever.
    for _ in 0..64 {
        if current == ancestor {
            return true;
        }
        let Some(entry) = processes.get(&current) else {
            return false;
        };
        if entry.parent_pid == current || entry.parent_pid <= 1 {
            return false;
        }
        current = entry.parent_pid;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_is_its_own_descendant() {
        let pid = std::process::id();
        assert!(is_descendant(pid, pid));
    }

    #[test]
    fn unrelated_pids_are_not_descendants() {
        // Pid 1 is never a descendant of this test process.
        assert!(!is_descendant(1, std::process::id()));
    }

    #[test]
    fn locate_ignores_bridges_it_was_told_to_exclude() {
        let pid = std::process::id();
        // This process has no bridge token, so the only assertion available is
        // the exclusion path — which is the part with the interesting bug.
        assert!(locate(pid, &[pid]).is_none());
    }
}
