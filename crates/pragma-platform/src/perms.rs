//! Owner-only files and directories.
//!
//! Pragma writes several secrets to disk: the GitHub token, the gateway bearer
//! token, the paired-device list, and the server's own socket. On Unix these
//! have always been `0600` (`0700` for directories). This module is what keeps
//! that promise on Windows too.
//!
//! Windows has no mode bits, so the equivalent is an access-control list that
//! removes inherited entries and grants the owning user full control and
//! nobody else. That is applied with `icacls`, the in-box Windows tool for the
//! job, rather than the Win32 security APIs, because this workspace forbids
//! `unsafe` and every Rust binding for those APIs requires it. The call is
//! checked: if `icacls` is missing or fails, these functions return an error
//! rather than leaving a secret readable by other accounts.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

/// Creates (or truncates) a file that only its owner can read or write.
///
/// The access restriction is applied to the empty file *before* the handle is
/// returned, so the caller's contents are never briefly present on disk under
/// looser permissions.
pub fn create_private_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;

    // Re-apply unconditionally: `create` on an existing path keeps whatever
    // permissions that file already had, which may be looser than we want.
    restrict_to_owner(path)?;
    Ok(file)
}

/// Creates a directory tree whose leaf only its owner can enter or list.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    restrict_to_owner(path)
}

/// Restricts an existing file or directory to its owner.
///
/// Directories additionally get their restriction applied to entries created
/// inside them from now on, matching the `0700` semantics on Unix.
pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
    let is_dir = fs::metadata(path)?.is_dir();
    restrict_to_owner_inner(path, is_dir)
}

#[cfg(unix)]
fn restrict_to_owner_inner(path: &Path, is_dir: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if is_dir { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(windows)]
fn restrict_to_owner_inner(path: &Path, is_dir: bool) -> io::Result<()> {
    use std::process::Command;

    let principal = owner_principal()?;
    // `(OI)(CI)` makes the grant inheritable by files and subdirectories, which
    // is what gives a directory the same reach `0700` has on Unix.
    let rights = if is_dir {
        format!("{principal}:(OI)(CI)(F)")
    } else {
        format!("{principal}:(F)")
    };

    let output = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(&rights)
        .output()?;

    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "could not restrict {} to {principal}: icacls exited with {}: {}",
                path.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(())
}

/// Marks a file executable.
///
/// On Windows executability is decided by the file extension, not by a
/// permission bit, so there is nothing to set and nothing is silently lost.
pub fn set_executable(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)
    }
    #[cfg(not(unix))]
    {
        // Touch the argument so the signature stays honest on every platform.
        let _ = fs::metadata(path)?;
        Ok(())
    }
}

/// Reads the account name `icacls` should grant access to.
#[cfg(windows)]
fn owner_principal() -> io::Result<String> {
    principal_from(
        std::env::var_os("USERDOMAIN").as_deref(),
        std::env::var_os("USERNAME").as_deref(),
    )
}

/// Builds the `DOMAIN\user` principal `icacls` expects.
///
/// Kept separate from the environment lookup so the rule is testable on every
/// platform, and fallible on purpose: guessing a principal would mean granting
/// access to the wrong account, and silently skipping the grant would leave a
/// token world-readable. Both are worse than refusing to write the file.
#[cfg_attr(not(windows), allow(dead_code))]
fn principal_from(
    domain: Option<&std::ffi::OsStr>,
    user: Option<&std::ffi::OsStr>,
) -> io::Result<String> {
    let user = user
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "USERNAME is unset, so the owning account for an owner-only file is unknown",
            )
        })?;

    let domain = domain
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty());

    Ok(match domain {
        Some(domain) => format!("{domain}\\{user}"),
        None => user,
    })
}

#[cfg(test)]
mod tests {
    use super::{create_private_dir, create_private_file, principal_from, restrict_to_owner};
    use std::ffi::OsStr;
    use std::io::Write;

    #[test]
    fn a_domain_account_is_qualified_with_its_domain() {
        let principal = principal_from(Some(OsStr::new("CORP")), Some(OsStr::new("ada")))
            .expect("a domain and a user is enough to name an account");
        assert_eq!(principal, "CORP\\ada");
    }

    #[test]
    fn a_local_account_is_named_on_its_own() {
        let principal = principal_from(None, Some(OsStr::new("ada")))
            .expect("a user alone names a local account");
        assert_eq!(principal, "ada");
    }

    /// A blank `USERDOMAIN` must not produce the principal `"\ada"`, which
    /// `icacls` rejects — and a rejected `icacls` would abort the write.
    #[test]
    fn a_blank_domain_is_treated_as_absent() {
        let principal = principal_from(Some(OsStr::new("   ")), Some(OsStr::new("ada")))
            .expect("a blank domain still leaves a usable local account");
        assert_eq!(principal, "ada");
    }

    /// Refusing here is the point: the alternative is writing a secret with
    /// whatever access control it happened to inherit.
    #[test]
    fn an_unknown_user_is_an_error_rather_than_a_guess() {
        let error = principal_from(Some(OsStr::new("CORP")), None)
            .expect_err("an unknown owner must not be guessed");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_private_file_holds_the_contents_written_to_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested").join("token");
        let mut file = create_private_file(&path).expect("a private file is creatable");
        file.write_all(b"secret").expect("write");
        drop(file);
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "secret");
    }

    /// Creating over an existing loose file must tighten it, not inherit it.
    #[test]
    fn recreating_an_existing_file_reapplies_the_restriction() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("token");
        std::fs::write(&path, "old").expect("seed a pre-existing file");
        loosen(&path);

        let mut file = create_private_file(&path).expect("a private file is creatable");
        file.write_all(b"new").expect("write");
        drop(file);

        assert_owner_only(&path);
    }

    #[test]
    fn a_private_directory_is_restricted() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("server");
        create_private_dir(&path).expect("a private dir is creatable");
        restrict_to_owner(&path).expect("restriction is idempotent");
        assert_owner_only(&path);
    }

    #[cfg(unix)]
    fn loosen(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
            .expect("loosen the file so the retightening is observable");
    }

    #[cfg(not(unix))]
    fn loosen(_path: &std::path::Path) {}

    #[cfg(unix)]
    fn assert_owner_only(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        let expected = if path.is_dir() { 0o700 } else { 0o600 };
        assert_eq!(mode, expected, "{} must be owner-only", path.display());
    }

    #[cfg(not(unix))]
    fn assert_owner_only(path: &std::path::Path) {
        assert!(path.exists());
    }
}
