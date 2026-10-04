//! Owner-only secret files under the per-instance app data dir.
//!
//! Every credential Pragma itself holds — the GitHub token, the System 1 API key —
//! is a plaintext file only the owning account can read: `0600` on Unix, an
//! owner-only ACL on Windows (via `pragma_platform::perms`). This is the model the
//! `gh` CLI uses. The OS keychain is deliberately avoided: its items are bound to
//! the app's code signature, which changes on every unsigned/dev rebuild and
//! triggers a fresh access prompt.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use pragma_platform::perms;

/// One secret stored in its own owner-only file.
#[derive(Clone)]
pub struct SecretFile {
    path: PathBuf,
}

impl SecretFile {
    /// A secret named `file_name` under `data_dir`.
    pub fn new(data_dir: &Path, file_name: &str) -> Self {
        Self {
            path: data_dir.join(file_name),
        }
    }

    /// The stored secret, or `None` when the file is missing, unreadable, or blank.
    pub fn read(&self) -> Option<String> {
        let secret = fs::read_to_string(&self.path).ok()?;
        let secret = secret.trim();
        (!secret.is_empty()).then(|| secret.to_string())
    }

    /// Writes the secret, re-applying owner-only permissions to an existing file
    /// in case it was once created more permissively.
    pub fn write(&self, secret: &str) -> io::Result<()> {
        let mut file = perms::create_private_file(&self.path)?;
        file.write_all(secret.as_bytes())
    }

    /// Removes the secret; a missing file is success.
    pub fn clear(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let secret = SecretFile::new(dir.path(), "secret");
        assert_eq!(secret.read(), None);
        secret.write("  value\n").unwrap();
        assert_eq!(secret.read().as_deref(), Some("value"));
        secret.clear().unwrap();
        assert_eq!(secret.read(), None);
        secret.clear().unwrap();
    }

    #[test]
    fn blank_file_reads_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let secret = SecretFile::new(dir.path(), "secret");
        secret.write(" \n").unwrap();
        assert_eq!(secret.read(), None);
    }
}
