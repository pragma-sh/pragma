//! Canonical paths other programs can read back.
//!
//! `std::fs::canonicalize` on Windows returns an **extended-length** (verbatim)
//! path — `\\?\C:\Users\dev\project`. That prefix is a Win32 API convention,
//! not a syntax the rest of the ecosystem understands: git reads `\\?\C:\…` as
//! the UNC path `//?/C:/…` and fails with `Invalid argument` the moment it has
//! to create leading directories under it.
//!
//! Pragma stores a canonical project root in its database and then hands that
//! same string to `git worktree add`, so "canonical" here has to mean *usable
//! by an external program*, not merely correct for `CreateFileW`. Every
//! canonicalization in the workspace goes through [`canonicalize`] for that
//! reason. Unix has no verbatim prefix, so there it is `std`'s behaviour.

use std::io;
use std::path::{Path, PathBuf};

/// Resolves `path` to an absolute path with symlinks and `..` removed, in a
/// form external programs (git, editors, shells) accept.
///
/// # Errors
///
/// Propagates the underlying `std::fs::canonicalize` error — most often the
/// path not existing, or a component not being a directory.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    Ok(simplified(std::fs::canonicalize(path)?))
}

/// Drops Windows' verbatim (`\\?\`) prefix when the remaining path is one the
/// ordinary Win32 rules already accept. Identity on Unix.
///
/// A path at or past `MAX_PATH` keeps its prefix: there the prefix is what
/// makes the path openable at all, and a caller that cannot handle it would
/// fail on the un-prefixed form too.
#[cfg(windows)]
#[must_use]
pub fn simplified(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    /// The classic Win32 path ceiling that the verbatim prefix exists to lift.
    const MAX_PATH: usize = 260;

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path;
    };
    let mut simplified = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => {
            let mut root = PathBuf::from(r"\\");
            root.push(server);
            root.push(share);
            root
        }
        // `\\?\` over a device path (`\\?\pipe\…`) has no plain equivalent, and
        // every non-verbatim prefix is already plain.
        _ => return path,
    };
    for component in components {
        // The root directory is already part of the rebuilt prefix; pushing it
        // again would reset the buffer back to `\`.
        if !matches!(component, Component::RootDir) {
            simplified.push(component.as_os_str());
        }
    }
    if simplified.as_os_str().len() < MAX_PATH {
        simplified
    } else {
        path
    }
}

/// Identity: Unix paths carry no verbatim prefix.
#[cfg(not(windows))]
#[must_use]
pub fn simplified(path: PathBuf) -> PathBuf {
    path
}

/// The user's home directory, however this platform spells it.
///
/// Windows sets `USERPROFILE`, not `HOME` — `HOME` exists there only when
/// something like Git Bash injects it, which a GUI-launched host does not have.
/// Reading `HOME` alone therefore resolves to nothing on Windows, which is how
/// home-relative lookups (`~/.pragma/…`, `~/.local/bin`) silently vanish there.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::{canonicalize, simplified};
    use std::path::PathBuf;

    /// The whole point of this module: whatever comes back is something an
    /// external program can be handed verbatim.
    #[test]
    fn a_canonical_path_carries_no_verbatim_prefix() {
        let dir = tempfile::tempdir().expect("temp dir");
        let nested = dir.path().join("project").join(".pragma");
        std::fs::create_dir_all(&nested).expect("nested dirs");

        let canonical = canonicalize(&nested).expect("canonicalize");

        assert!(
            !canonical.to_string_lossy().starts_with(r"\\?\"),
            "canonical path must not keep the Windows verbatim prefix: {}",
            canonical.display()
        );
        assert!(canonical.ends_with(".pragma"));
    }

    #[test]
    fn canonicalizing_a_missing_path_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(canonicalize(dir.path().join("absent")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_disk_path_loses_its_prefix() {
        assert_eq!(
            simplified(PathBuf::from(r"\\?\C:\Users\dev\project")),
            PathBuf::from(r"C:\Users\dev\project")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_unc_path_becomes_a_plain_unc_path() {
        assert_eq!(
            simplified(PathBuf::from(r"\\?\UNC\server\share\project")),
            PathBuf::from(r"\\server\share\project")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_plain_path_is_left_alone() {
        assert_eq!(
            simplified(PathBuf::from(r"C:\Users\dev")),
            PathBuf::from(r"C:\Users\dev")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn simplifying_a_unix_path_changes_nothing() {
        assert_eq!(
            simplified(PathBuf::from("/Users/dev/project")),
            PathBuf::from("/Users/dev/project")
        );
    }
}
