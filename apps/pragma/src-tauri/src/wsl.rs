//! WSL availability probe and shell-picker support.
//!
//! The desktop app needs to know whether it runs on Windows with WSL installed
//! before it can offer distribution shells in the new-tab menu and the
//! Terminal settings section. `list_distros` is compiled on every platform
//! (see `crates/pragma-client/src/wsl.rs`), so the probe below works
//! everywhere and simply reports no distributions where `wsl.exe` is absent.

use std::num::NonZeroU64;

use pragma_constants::{WslDistro, WslDistroList};

/// Probes WSL: whether this is Windows, and which distributions are installed.
///
/// A failing probe (no `wsl.exe`, no distributions, a WSL error) yields an
/// empty list rather than an error — the caller treats it as "WSL not
/// available" and hides every WSL-dependent feature.
#[tauri::command]
pub async fn list_wsl_distros() -> WslDistroList {
    tauri::async_runtime::spawn_blocking(probe_wsl)
        .await
        .unwrap_or_else(|_| WslDistroList {
            is_windows: cfg!(windows),
            distros: Vec::new(),
        })
}

fn probe_wsl() -> WslDistroList {
    let distros = pragma_client::list_distros().unwrap_or_default();
    WslDistroList {
        is_windows: cfg!(windows),
        distros: distros
            .into_iter()
            .map(|distro| WslDistro {
                name: distro.name,
                running: distro.running,
                // The schema pins the version to >= 1, so it is a `NonZero`.
                // WSL only ever reports 1 or 2; a parsed 0 falls back to 1
                // rather than dropping the distribution.
                version: NonZeroU64::new(u64::from(distro.version)).unwrap_or(NonZeroU64::MIN),
                default: distro.default,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::probe_wsl;

    /// On macOS and Linux the probe must report a non-Windows host with no
    /// distributions; on Windows it must at least agree about being Windows.
    /// (`wsl.exe` is absent from CI's Windows image, so the list stays empty
    /// there too, but that is not asserted — a developer machine may have
    /// distributions installed.)
    #[test]
    fn the_probe_matches_the_host_platform() {
        let list = probe_wsl();
        assert_eq!(list.is_windows, cfg!(windows));
        if !cfg!(windows) {
            assert!(list.distros.is_empty());
        }
    }
}
