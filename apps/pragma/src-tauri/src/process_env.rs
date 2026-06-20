use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Creates a child-process command with a PATH suitable for GUI-launched apps.
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env("PATH", user_path());
    command
}

fn user_path() -> OsString {
    let current = env::var_os("PATH").unwrap_or_default();
    let home = env::var_os("HOME").map(PathBuf::from);
    user_path_from(current, home.as_deref())
}

fn user_path_from(current: OsString, home: Option<&Path>) -> OsString {
    let fallback = current.clone();
    let mut entries: Vec<PathBuf> = env::split_paths(&current).collect();

    if let Some(home) = home {
        push_path(&mut entries, home.join(".bun/bin"));
        push_path(&mut entries, home.join(".local/bin"));
        push_path(&mut entries, home.join(".cargo/bin"));
    }

    for path in [
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
        let path = user_path_from(OsString::from("/usr/bin"), Some(Path::new("/Users/dev")));
        let entries: Vec<PathBuf> = env::split_paths(&path).collect();

        assert_eq!(entries.first(), Some(&PathBuf::from("/usr/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.bun/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.local/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/dev/.cargo/bin")));
        assert!(entries.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn user_path_does_not_duplicate_entries() {
        let path = user_path_from(
            OsString::from("/Users/dev/.bun/bin:/usr/local/bin"),
            Some(Path::new("/Users/dev")),
        );
        let entries: Vec<PathBuf> = env::split_paths(&path).collect();

        assert_eq!(
            entries
                .iter()
                .filter(|entry| *entry == &PathBuf::from("/Users/dev/.bun/bin"))
                .count(),
            1,
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| *entry == &PathBuf::from("/usr/local/bin"))
                .count(),
            1,
        );
    }
}
