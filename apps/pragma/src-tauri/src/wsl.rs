//! WSL availability probe and shell-picker support.
//!
//! The desktop app needs to know whether the machine a terminal will run on is
//! Windows with WSL installed before it can offer distribution shells in the
//! new-tab menu and the Terminal settings section.
//!
//! **The probe is host-scoped, not app-scoped.** A worktree belonging to a
//! project opened over SSH runs its terminals on the remote daemon's machine,
//! so asking the desktop's own `wsl.exe` is answering a question about the
//! wrong computer: it hides the distributions the remote host actually has and
//! offers local ones the remote daemon cannot launch. The probe therefore goes
//! out as a `wsl` RPC to the host that owns the worktree, which for a local
//! project is the managed local server and answers exactly as before.

use pragma_constants::{ProtocolRpcMethod, WslDistroList};
use serde_json::json;
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::hosts::Hosts;
use crate::ssh_host;

/// Probes WSL on the host that owns `worktree_id`: whether it is Windows, and
/// which distributions are installed there.
///
/// `worktree_id` is `None` for surfaces with no worktree in hand (global
/// settings), which probes the local host — the machine those settings describe.
///
/// Anything that goes wrong (an unreachable host, a daemon too old to know the
/// `wsl` method, no `wsl.exe`, a WSL error) yields an empty list rather than an
/// error. The caller reads that as "WSL not available" and hides every
/// WSL-dependent affordance, which is the only thing a user could do about it
/// anyway.
#[tauri::command]
pub async fn list_wsl_distros(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: Option<String>,
) -> AppResult<WslDistroList> {
    Ok(probe(app, &db, &hosts, worktree_id.as_deref())
        .await
        .unwrap_or_else(no_wsl))
}

/// The list reported when the probe could not be completed.
///
/// Deliberately *not* `cfg!(windows)`: the desktop app's own platform says
/// nothing about the host that failed to answer, and claiming a Windows host
/// with no distributions would invite the UI to offer an install prompt for a
/// machine it never reached.
fn no_wsl() -> WslDistroList {
    WslDistroList {
        is_windows: false,
        distros: Vec::new(),
    }
}

async fn probe(
    app: tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    worktree_id: Option<&str>,
) -> Option<WslDistroList> {
    let client = match worktree_id {
        Some(worktree_id) => ssh_host::client_for_worktree(app, db, hosts, worktree_id)
            .await
            .ok()?,
        None => hosts.local(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let value = client.rpc(ProtocolRpcMethod::Wsl, json!({})).ok()?;
        serde_json::from_value(value).ok()
    })
    .await
    .ok()?
}

#[cfg(test)]
mod tests {
    use super::no_wsl;

    /// The desktop app's own platform is not evidence about a host it failed to
    /// reach. Reporting `isWindows` from `cfg!(windows)` here would tell the UI
    /// "a Windows host with nothing installed" about a remote Linux machine
    /// whose daemon simply did not answer.
    #[test]
    fn an_unreachable_host_is_not_claimed_to_be_windows() {
        assert!(!no_wsl().is_windows);
        assert!(no_wsl().distros.is_empty());
    }
}
