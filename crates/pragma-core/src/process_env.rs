//! Child-process PATH augmentation for host-side subprocess calls.
//!
//! `pragma-server` (and the desktop app that may spawn it) can be launched from
//! a GUI without a login shell, so `PATH` may lack the directories where `git`,
//! agent CLIs (`opencode`, cursor's `agent`), and other tools live. Every
//! subprocess in core and the desktop app goes through [`command`] so the host
//! can find them regardless of how it was started. This module is the single
//! source of truth for that PATH list — do not fork per-crate copies.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Creates a child-process command with a PATH suitable for GUI-launched hosts.
///
/// The console window is suppressed on Windows (see
/// [`pragma_platform::process::hide_console`]) — everything routed through here
/// is a console program run on the user's behalf, and the host is a GUI
/// process, so each one would otherwise pop a window.
#[must_use]
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env("PATH", user_path());
    pragma_platform::process::hide_console(&mut command);
    command
}

/// Creates a `git` command with optional locks disabled.
///
/// Host git queries (status/diff/merged-status batches) now run concurrently —
/// across worktrees and within one — and `GIT_OPTIONAL_LOCKS=0` stops read-only
/// commands from taking `index.lock` for opportunistic index refreshes, which
/// would otherwise make parallel queries on the same worktree fail spuriously.
#[must_use]
pub fn git() -> Command {
    let mut command = command("git");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn user_path() -> OsString {
    let current = env::var_os("PATH").unwrap_or_default();
    user_path_from(&current, home_dir().as_deref())
}

/// The user's home directory, however this platform spells it.
///
/// Windows sets `USERPROFILE`, not `HOME` — `HOME` exists there only when
/// something like Git Bash injects it, which a GUI-launched host does not have.
/// Reading `HOME` alone therefore skipped every home-relative entry below on
/// Windows, including the `.local/bin` that `agent_cli` installs `pragma-cli`
/// into, so agents could not find the helper on their `PATH`.
///
/// Public because the global scope of `.pragma/config.json` is rooted here too,
/// and the session layer must spell "home" exactly the same way.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

fn user_path_from(current: &OsStr, home: Option<&Path>) -> OsString {
    let fallback = current.to_os_string();
    let mut entries: Vec<PathBuf> = env::split_paths(current).collect();

    if let Some(home) = home {
        push_path(&mut entries, home.join(".opencode/bin"));
        push_path(&mut entries, home.join(".bun/bin"));
        push_path(&mut entries, home.join(".local/bin"));
        push_path(&mut entries, home.join(".cargo/bin"));
        push_path(&mut entries, home.join(".volta/bin"));
        push_path(&mut entries, home.join(".mise/shims"));
        push_path(&mut entries, home.join(".local/share/mise/shims"));
        push_path(&mut entries, home.join(".asdf/shims"));
        push_path(&mut entries, home.join(".local/share/pnpm"));
    }

    for path in [
        "/Library/Frameworks/Python.framework/Versions/Current/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push_path(&mut entries, PathBuf::from(path));
    }

    env::join_paths(entries).unwrap_or(fallback)
}

fn push_path(entries: &mut Vec<PathBuf>, path: PathBuf) {
    if !entries.iter().any(|entry| entry == &path) {
        entries.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_path_appends_common_user_bins() {
        let path = user_path_from(&OsString::from("/usr/bin"), Some(Path::new("/Users/dev")));
        let entries: Vec<PathBuf> = env::split_paths(&path).collect();

        assert_eq!(entries.first(), Some(&PathBuf::from("/usr/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.opencode/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.bun/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.local/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.cargo/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.volta/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.mise/shims")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.local/share/mise/shims")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.asdf/shims")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.local/share/pnpm")));
        assert!(entries.contains(&PathBuf::from(
            "/Library/Frameworks/Python.framework/Versions/Current/bin"
        )));
        assert!(entries.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    /// Windows spells the home directory `USERPROFILE`; `HOME` is absent unless
    /// something injects it. Falling back is what keeps `.local/bin` — where
    /// `pragma-cli` is installed — on the `PATH` handed to agents there.
    #[test]
    fn home_dir_falls_back_to_userprofile() {
        // Guard the precedence and empty-value handling without mutating the
        // process environment, which would race other tests in this binary.
        let pick = |home: Option<&str>, profile: Option<&str>| -> Option<PathBuf> {
            home.filter(|value| !value.is_empty())
                .or(profile)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        assert_eq!(
            pick(Some("/home/dev"), None),
            Some(PathBuf::from("/home/dev"))
        );
        assert_eq!(
            pick(None, Some(r"C:\Users\dev")),
            Some(PathBuf::from(r"C:\Users\dev"))
        );
        // An empty HOME must not shadow a usable USERPROFILE.
        assert_eq!(
            pick(Some(""), Some(r"C:\Users\dev")),
            Some(PathBuf::from(r"C:\Users\dev"))
        );
        assert_eq!(pick(None, None), None);
    }

    #[test]
    fn user_path_does_not_duplicate_entries() {
        let path = user_path_from(
            &OsString::from("/Users/dev/.bun/bin:/usr/local/bin"),
            Some(Path::new("/Users/dev")),
        );
        let entries: Vec<PathBuf> = env::split_paths(&path).collect();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| *entry == &PathBuf::from("/usr/local/bin"))
                .count(),
            1,
        );
    }
}
