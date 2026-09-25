//! How much disk a file actually occupies.
//!
//! `Metadata::len` is the file's *apparent* size, which is the wrong number for
//! a storage report twice over: a sparse file (a VM image, a preallocated
//! database) claims far more than it uses, and package managers that hard-link
//! one store into every `node_modules` (pnpm, bun) would be counted once per
//! link. Unix reports both the allocated blocks and the inode identity, so the
//! storage scan charges each inode once, at its allocated size. Windows' stable
//! `std` exposes neither, so there the apparent size is the honest answer and a
//! file has no identity to deduplicate by.

use std::fs::Metadata;

/// Identity of a file that other directory entries may share (a hard link).
///
/// `None` means the entry is the only name for its data, so the caller never
/// has to remember it — which keeps the dedupe set to the few multiply-linked
/// files instead of every file on the disk.
pub type FileIdentity = (u64, u64);

/// Bytes `metadata`'s file occupies on disk.
#[cfg(unix)]
#[must_use]
pub fn allocated_bytes(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;

    // `st_blocks` is always in 512-byte units, whatever the filesystem's block
    // size — POSIX fixes that unit for exactly this calculation.
    metadata.blocks().saturating_mul(512)
}

/// Bytes `metadata`'s file occupies on disk.
#[cfg(not(unix))]
#[must_use]
pub fn allocated_bytes(metadata: &Metadata) -> u64 {
    metadata.len()
}

/// The inode shared by every hard link to this file, or `None` when the file
/// has a single name.
#[cfg(unix)]
#[must_use]
pub fn shared_identity(metadata: &Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    (metadata.nlink() > 1).then(|| (metadata.dev(), metadata.ino()))
}

/// The inode shared by every hard link to this file, or `None` when the file
/// has a single name. Windows' file index is not exposed by stable `std`, so
/// every link is charged; the report overstates rather than failing.
#[cfg(not(unix))]
#[must_use]
pub fn shared_identity(_metadata: &Metadata) -> Option<FileIdentity> {
    None
}

#[cfg(test)]
mod tests {
    use super::{allocated_bytes, shared_identity};

    #[test]
    fn a_written_file_occupies_at_least_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        std::fs::write(&path, vec![7_u8; 64 * 1024]).unwrap();
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert!(allocated_bytes(&metadata) >= 64 * 1024);
        assert_eq!(shared_identity(&metadata), None);
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_share_one_identity() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a");
        let second = dir.path().join("b");
        std::fs::write(&first, b"shared").unwrap();
        std::fs::hard_link(&first, &second).unwrap();
        let a = shared_identity(&std::fs::symlink_metadata(&first).unwrap());
        let b = shared_identity(&std::fs::symlink_metadata(&second).unwrap());
        assert!(a.is_some());
        assert_eq!(a, b);
    }
}
