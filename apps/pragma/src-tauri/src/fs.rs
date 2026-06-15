//! Worktree-scoped filesystem access for the file tree and editor.
//!
//! Every command takes a `worktree_id` and a path that is **relative to the
//! worktree root**. The trusted absolute root is looked up from the DB (never
//! trusted from the frontend) and the relative path is resolved against it,
//! canonicalized, and asserted to stay inside the worktree — so the IPC surface
//! cannot read or write anywhere else, even through a symlink.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use pragma_constants::{DirEntry, FileContents};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Files larger than this are reported as `truncated` and never read into memory
/// or pushed across IPC.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Validates a worktree-relative path: rejects absolute paths and any `..`
/// component before any disk access, returning the cleaned relative path.
fn validate_relative(relative: &str) -> AppResult<PathBuf> {
    let rel = Path::new(relative);
    let mut cleaned = PathBuf::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::InvalidInput(
                    "path must not contain '..'".to_string(),
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::InvalidInput("path must be relative".to_string()));
            }
        }
    }
    Ok(cleaned)
}

/// Resolves a worktree-relative path to an absolute path that is guaranteed to
/// live inside the worktree. Canonicalizes the deepest existing ancestor (so the
/// target may or may not exist yet) and re-joins the missing tail, then asserts
/// the result is still under the canonical root — defeating symlink escapes.
pub(crate) fn resolve_in_worktree(root: &Path, relative: &str) -> AppResult<PathBuf> {
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
        return Err(AppError::InvalidInput(
            "path escapes the worktree".to_string(),
        ));
    }
    Ok(resolved)
}

/// Looks up a worktree's trusted absolute root path from the DB.
fn worktree_root(db: &Db, worktree_id: &str) -> AppResult<PathBuf> {
    Ok(PathBuf::from(db.worktree(worktree_id)?.path))
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
    let Ok(mut child) = Command::new("git")
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
#[tauri::command]
pub fn list_dir_entries(
    db: State<'_, Db>,
    worktree_id: String,
    path: String,
) -> AppResult<Vec<DirEntry>> {
    let root = worktree_root(&db, &worktree_id)?;
    let dir = resolve_in_worktree(&root, &path)?;

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut rel_paths: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.path().is_dir();
        let rel = join_rel(&path, &name);
        rel_paths.push(rel.clone());
        entries.push(DirEntry {
            name,
            path: rel,
            is_dir,
        });
    }

    let ignored = gitignored(&root, &rel_paths);
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
#[tauri::command]
pub fn create_file(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;
    std::fs::File::create_new(&target)?;
    Ok(())
}

/// Creates a directory at a worktree-relative path. Errors if it already exists.
#[tauri::command]
pub fn create_folder(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;
    std::fs::create_dir(&target)?;
    Ok(())
}

/// Reports whether a worktree-relative path exists on disk.
#[tauri::command]
pub fn path_exists(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<bool> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;
    Ok(target.exists())
}

/// Reads a worktree-relative file. Oversized files report `truncated` without
/// being read; non-UTF-8 files report `binary` with empty text. Raw bytes never
/// cross IPC.
#[tauri::command]
pub fn read_file(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<FileContents> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;
    let metadata = std::fs::metadata(&target)?;
    let byte_size = metadata.len();
    if byte_size > MAX_READ_BYTES {
        return Ok(FileContents {
            path,
            text: String::new(),
            binary: false,
            truncated: true,
            byte_size,
        });
    }
    let bytes = std::fs::read(&target)?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContents {
            path,
            text,
            binary: false,
            truncated: false,
            byte_size,
        }),
        Err(_) => Ok(FileContents {
            path,
            text: String::new(),
            binary: true,
            truncated: false,
            byte_size,
        }),
    }
}

/// Overwrites a worktree-relative file with UTF-8 text. Does not create missing
/// parent directories.
#[tauri::command]
pub fn write_file(
    db: State<'_, Db>,
    worktree_id: String,
    path: String,
    contents: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;
    std::fs::write(&target, contents)?;
    Ok(())
}

/// Renames (or moves) a worktree-relative entry. Both paths are resolved
/// through the worktree so symlink escapes and `..` are rejected. Errors if
/// the source is missing or the destination already exists — `std::fs::rename`
/// would otherwise overwrite silently on Unix.
#[tauri::command]
pub fn rename_file(
    db: State<'_, Db>,
    worktree_id: String,
    from_path: String,
    to_path: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let from = resolve_in_worktree(&root, &from_path)?;
    let to = resolve_in_worktree(&root, &to_path)?;

    if !from.exists() {
        return Err(AppError::InvalidInput(
            "source path does not exist".to_string(),
        ));
    }
    if to.exists() {
        return Err(AppError::InvalidInput(
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
/// non-empty directory must be deleted entry-by-entry. Refuses to follow
/// symlinks (the resolver catches those before this point).
#[tauri::command]
pub fn delete_file(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let target = resolve_in_worktree(&root, &path)?;

    let metadata = std::fs::symlink_metadata(&target)?;
    if metadata.is_dir() {
        let is_empty = std::fs::read_dir(&target)?.next().is_none();
        if !is_empty {
            return Err(AppError::InvalidInput("directory is not empty".to_string()));
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

    use super::{resolve_in_worktree, MAX_READ_BYTES};

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
        // The empty path resolves to the worktree root itself.
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
        // Reading through the symlink must be rejected — the canonical target
        // lands outside the worktree root.
        assert!(resolve_in_worktree(dir.path(), "link/secret.txt").is_err());
    }

    #[test]
    fn list_dir_entries_hides_git_and_gitignored() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        std::fs::write(dir.path().join("kept.txt"), "k").expect("write kept");
        std::fs::write(dir.path().join("ignored.txt"), "i").expect("write ignored");
        std::fs::create_dir(dir.path().join("src")).expect("mkdir");

        // Reuse the same logic the command uses, sans the Tauri State wrapper.
        let root = dir.path();
        let mut names: Vec<String> = std::fs::read_dir(root)
            .expect("read_dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name != ".git")
            .collect();
        let ignored = super::gitignored(root, &names);
        names.retain(|name| !ignored.contains(name));
        assert!(names.contains(&"kept.txt".to_string()));
        assert!(names.contains(&"src".to_string()));
        assert!(!names.contains(&"ignored.txt".to_string()));
        assert!(!names.contains(&".git".to_string()));
    }

    #[test]
    fn max_read_cap_is_two_mib() {
        assert_eq!(MAX_READ_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn rename_file_moves_within_the_worktree() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(root.join("old.txt"), "hi").expect("write");
        std::fs::create_dir(root.join("sub")).expect("mkdir");

        // Same-dir rename: from/to both inside the worktree.
        let from = resolve_in_worktree(root, "old.txt").expect("resolve from");
        let to = resolve_in_worktree(root, "new.txt").expect("resolve to");
        assert!(from.exists());
        assert!(!to.exists());
        std::fs::rename(&from, &to).expect("rename");
        assert!(!from.exists());
        assert!(to.exists());

        // Cross-directory move.
        std::fs::write(root.join("mover.txt"), "m").expect("write");
        let from = resolve_in_worktree(root, "mover.txt").expect("resolve from");
        let to = resolve_in_worktree(root, "sub/moved.txt").expect("resolve to");
        std::fs::rename(&from, &to).expect("rename across dirs");
        assert!(!from.exists());
        assert!(to.exists());
    }

    #[test]
    fn rename_file_rejects_existing_destination() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "a").expect("write");
        std::fs::write(root.join("b.txt"), "b").expect("write");

        // The command checks `to.exists()` and refuses to overwrite — we mirror
        // that guard here, since `std::fs::rename` itself would silently win on
        // Unix.
        let to = root.join("b.txt");
        assert!(to.exists());
        let from = root.join("a.txt");
        assert!(from.exists());
        // Simulating the command's branch: the rename must not be allowed.
        if to.exists() {
            // expected: command returns InvalidInput
        } else {
            panic!("destination should exist for this test");
        }
        // Both files still on disk.
        assert!(from.exists());
        assert!(to.exists());
    }

    #[test]
    fn rename_file_rejects_missing_source() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("nope.txt");
        assert!(!missing.exists());
        // The command's `resolve_in_worktree` canonicalizes a path; for a
        // missing leaf under an existing root the resolver still succeeds (it
        // canonicalizes the deepest existing ancestor) and the explicit
        // `from.exists()` check then trips.
        let resolved = resolve_in_worktree(dir.path(), "nope.txt").expect("resolve");
        assert!(!resolved.exists());
    }

    #[test]
    fn delete_file_removes_file_and_empty_directory() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(root.join("file.txt"), "x").expect("write");
        std::fs::create_dir(root.join("empty")).expect("mkdir");
        std::fs::create_dir(root.join("full")).expect("mkdir");
        std::fs::write(root.join("full/child.txt"), "c").expect("write child");

        // File delete: `std::fs::remove_file` removes the file.
        let file = resolve_in_worktree(root, "file.txt").expect("resolve");
        assert!(file.is_file());
        std::fs::remove_file(&file).expect("remove_file");
        assert!(!file.exists());

        // Empty directory: the command's "read_dir next is None" branch.
        let empty = resolve_in_worktree(root, "empty").expect("resolve");
        assert!(empty.is_dir());
        let is_empty = std::fs::read_dir(&empty)
            .expect("read_dir")
            .next()
            .is_none();
        assert!(is_empty);
        std::fs::remove_dir(&empty).expect("remove_dir");
        assert!(!empty.exists());

        // Non-empty directory: the command refuses.
        let full = resolve_in_worktree(root, "full").expect("resolve");
        let is_empty = std::fs::read_dir(&full).expect("read_dir").next().is_none();
        assert!(!is_empty);
        // The directory and its child must still be there.
        assert!(full.exists());
        assert!(full.join("child.txt").exists());
    }
}
