//! Host-side worktree filesystem operations behind the `filesystem` RPC method.
//!
//! Every request carries the **trusted absolute worktree root** (resolved by the
//! native client from its local DB, never accepted from the webview) plus a path
//! that is **relative to that root**. The relative path is resolved against the
//! root, canonicalized, and asserted to stay inside the worktree, so a request
//! cannot read or write anywhere else, even through a symlink. The work runs on
//! whichever host owns the socket — local for local projects, the remote box for
//! SSH-bridged projects.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;

use pragma_constants::{DirEntry, FileContents};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process_env;
use crate::{CoreError, CoreResult};

/// Files larger than this are reported as `truncated` and never read into memory
/// or returned across the wire.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// One filesystem operation request. `root` is the trusted absolute worktree
/// root; all other paths are worktree-relative.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FsRequest {
    /// Lists the immediate entries of a worktree-relative directory.
    ListDir { root: String, path: String },
    /// Creates an empty file.
    CreateFile { root: String, path: String },
    /// Creates a directory.
    CreateFolder { root: String, path: String },
    /// Reports whether a path exists.
    PathExists { root: String, path: String },
    /// Reads a file's contents.
    ReadFile { root: String, path: String },
    /// Overwrites a file with UTF-8 text.
    WriteFile {
        root: String,
        path: String,
        contents: String,
    },
    /// Renames (or moves) an entry within the worktree.
    Rename {
        root: String,
        from: String,
        to: String,
    },
    /// Deletes a file or empty directory.
    Delete { root: String, path: String },
}

/// Dispatches a `filesystem` RPC payload to the matching operation and returns a
/// JSON response payload.
pub fn handle(payload: Value) -> CoreResult<Value> {
    let request: FsRequest = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    match request {
        FsRequest::ListDir { root, path } => to_value(list_dir(&root, &path)?),
        FsRequest::CreateFile { root, path } => to_value(create_file(&root, &path)?),
        FsRequest::CreateFolder { root, path } => to_value(create_folder(&root, &path)?),
        FsRequest::PathExists { root, path } => to_value(path_exists(&root, &path)?),
        FsRequest::ReadFile { root, path } => to_value(read_file(&root, &path)?),
        FsRequest::WriteFile {
            root,
            path,
            contents,
        } => to_value(write_file(&root, &path, &contents)?),
        FsRequest::Rename { root, from, to } => to_value(rename(&root, &from, &to)?),
        FsRequest::Delete { root, path } => to_value(delete(&root, &path)?),
    }
}

fn to_value<T: Serialize>(value: T) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Operation(error.to_string()))
}

/// Validates a worktree-relative path: rejects absolute paths and any `..`
/// component before any disk access, returning the cleaned relative path.
fn validate_relative(relative: &str) -> CoreResult<PathBuf> {
    let rel = Path::new(relative);
    let mut cleaned = PathBuf::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(CoreError::InvalidPayload(
                    "path must not contain '..'".to_string(),
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(CoreError::InvalidPayload(
                    "path must be relative".to_string(),
                ));
            }
        }
    }
    Ok(cleaned)
}

/// Resolves a worktree-relative path to an absolute path guaranteed to live
/// inside the worktree. Canonicalizes the deepest existing ancestor (so the
/// target may or may not exist yet) and re-joins the missing tail, then asserts
/// the result is still under the canonical root — defeating symlink escapes.
pub fn resolve_in_worktree(root: &Path, relative: &str) -> CoreResult<PathBuf> {
    let rel = validate_relative(relative)?;
    let canonical_root = root.canonicalize()?;
    let joined = canonical_root.join(&rel);

    let mut ancestor = joined.clone();
    let mut tail: Vec<OsString> = Vec::new();
    while !ancestor.exists() {
        let Some(name) = ancestor.file_name() else {
            break;
        };
        tail.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent.to_path_buf();
    }
    let mut resolved = ancestor.canonicalize()?;
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(CoreError::InvalidPayload(
            "path escapes the worktree".to_string(),
        ));
    }
    Ok(resolved)
}

/// Joins a worktree-relative directory prefix and an entry name into a POSIX
/// (forward-slash) worktree-relative path.
fn join_rel(prefix: &str, name: &str) -> String {
    let prefix = prefix.trim_matches('/');
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Returns the subset of `rel_paths` that git would ignore, in one batched
/// `git check-ignore` call. Best-effort: any failure yields an empty set so the
/// tree still renders (it just won't hide ignored files).
fn gitignored(root: &Path, rel_paths: &[String]) -> HashSet<String> {
    if rel_paths.is_empty() {
        return HashSet::new();
    }
    let Ok(mut child) = process_env::command("git")
        .args([
            "-C",
            &root.to_string_lossy(),
            "check-ignore",
            "--stdin",
            "-z",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashSet::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        let mut buffer = Vec::new();
        for path in rel_paths {
            buffer.extend_from_slice(path.as_bytes());
            buffer.push(0);
        }
        let _ = stdin.write_all(&buffer);
    }
    let Ok(output) = child.wait_with_output() else {
        return HashSet::new();
    };
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|slice| !slice.is_empty())
        .map(|slice| String::from_utf8_lossy(slice).into_owned())
        .collect()
}

/// Lists the immediate entries of a worktree-relative directory (`""` = root),
/// hiding `.git` and gitignored entries, sorted directories-first then by name.
fn list_dir(root: &str, path: &str) -> CoreResult<Vec<DirEntry>> {
    let root = Path::new(root);
    let dir = resolve_in_worktree(root, path)?;

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut rel_paths: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.path().is_dir();
        let rel = join_rel(path, &name);
        rel_paths.push(rel.clone());
        entries.push(DirEntry {
            name,
            path: rel,
            is_dir,
        });
    }

    let ignored = gitignored(root, &rel_paths);
    entries.retain(|entry| !ignored.contains(&entry.path));
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Creates an empty file at a worktree-relative path. Errors if it already
/// exists; does not create missing parent directories.
fn create_file(root: &str, path: &str) -> CoreResult<()> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    std::fs::File::create_new(&target)?;
    Ok(())
}

/// Creates a directory at a worktree-relative path. Errors if it already exists.
fn create_folder(root: &str, path: &str) -> CoreResult<()> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    std::fs::create_dir(&target)?;
    Ok(())
}

/// Reports whether a worktree-relative path exists on disk.
fn path_exists(root: &str, path: &str) -> CoreResult<bool> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    Ok(target.exists())
}

/// Reads a worktree-relative file. Oversized files report `truncated` without
/// being read; non-UTF-8 files report `binary` with empty text.
fn read_file(root: &str, path: &str) -> CoreResult<FileContents> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    let metadata = std::fs::metadata(&target)?;
    let byte_size = metadata.len();
    if byte_size > MAX_READ_BYTES {
        return Ok(FileContents {
            path: path.to_string(),
            text: String::new(),
            binary: false,
            truncated: true,
            byte_size,
        });
    }
    let bytes = std::fs::read(&target)?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContents {
            path: path.to_string(),
            text,
            binary: false,
            truncated: false,
            byte_size,
        }),
        Err(_) => Ok(FileContents {
            path: path.to_string(),
            text: String::new(),
            binary: true,
            truncated: false,
            byte_size,
        }),
    }
}

/// Overwrites a worktree-relative file with UTF-8 text. Does not create missing
/// parent directories.
fn write_file(root: &str, path: &str, contents: &str) -> CoreResult<()> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    std::fs::write(&target, contents)?;
    Ok(())
}

/// Renames (or moves) a worktree-relative entry. Both paths are resolved through
/// the worktree so symlink escapes and `..` are rejected. Errors if the source
/// is missing or the destination already exists.
fn rename(root: &str, from_path: &str, to_path: &str) -> CoreResult<()> {
    let root = Path::new(root);
    let from = resolve_in_worktree(root, from_path)?;
    let to = resolve_in_worktree(root, to_path)?;

    if !from.exists() {
        return Err(CoreError::InvalidPayload(
            "source path does not exist".to_string(),
        ));
    }
    if to.exists() {
        return Err(CoreError::InvalidPayload(
            "destination path already exists".to_string(),
        ));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(())
}

/// Deletes a worktree-relative file or empty directory. Refuses to recurse — a
/// non-empty directory must be deleted entry-by-entry.
fn delete(root: &str, path: &str) -> CoreResult<()> {
    let target = resolve_in_worktree(Path::new(root), path)?;

    let metadata = std::fs::symlink_metadata(&target)?;
    if metadata.is_dir() {
        let is_empty = std::fs::read_dir(&target)?.next().is_none();
        if !is_empty {
            return Err(CoreError::InvalidPayload(
                "directory is not empty".to_string(),
            ));
        }
        std::fs::remove_dir(&target)?;
    } else {
        std::fs::remove_file(&target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::tempdir;

    use super::{gitignored, resolve_in_worktree, MAX_READ_BYTES};

    fn git_init(path: &std::path::Path) {
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(path)
            .output()
            .expect("git init");
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        let dir = tempdir().expect("tempdir");
        assert!(resolve_in_worktree(dir.path(), "../escape").is_err());
        assert!(resolve_in_worktree(dir.path(), "a/../../escape").is_err());
        assert!(resolve_in_worktree(dir.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn resolves_relative_paths_inside_the_worktree() {
        let dir = tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("src")).expect("mkdir");
        std::fs::write(dir.path().join("src/app.ts"), "x").expect("write");
        let resolved = resolve_in_worktree(dir.path(), "src/app.ts").expect("resolve");
        assert!(resolved.ends_with("src/app.ts"));
        let root = resolve_in_worktree(dir.path(), "").expect("resolve root");
        assert_eq!(root, dir.path().canonicalize().expect("canon"));
    }

    #[test]
    fn rejects_symlink_escape() {
        let dir = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside tempdir");
        std::fs::write(outside.path().join("secret.txt"), "secret").expect("write secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).expect("symlink");
        assert!(resolve_in_worktree(dir.path(), "link/secret.txt").is_err());
    }

    #[test]
    fn list_dir_hides_git_and_gitignored() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        std::fs::write(dir.path().join("kept.txt"), "k").expect("write kept");
        std::fs::write(dir.path().join("ignored.txt"), "i").expect("write ignored");

        let entries = super::list_dir(&dir.path().to_string_lossy(), "").expect("list");
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"kept.txt"));
        assert!(!names.contains(&"ignored.txt"));
        assert!(!names.contains(&".git"));
        // gitignored is exercised directly too.
        let ignored = gitignored(dir.path(), &["ignored.txt".to_string()]);
        assert!(ignored.contains("ignored.txt"));
    }

    #[test]
    fn reads_and_writes_within_the_worktree() {
        let dir = tempdir().expect("tempdir");
        super::write_file(&dir.path().to_string_lossy(), "note.txt", "hello").expect("write");
        let contents = super::read_file(&dir.path().to_string_lossy(), "note.txt").expect("read");
        assert_eq!(contents.text, "hello");
        assert!(!contents.binary);
    }

    #[test]
    fn max_read_cap_is_two_mib() {
        assert_eq!(MAX_READ_BYTES, 2 * 1024 * 1024);
    }
}
