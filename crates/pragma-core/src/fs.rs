//! Host-side worktree filesystem operations behind the `filesystem` RPC method.
//!
//! Every request carries the **trusted absolute worktree root** (resolved by the
//! native client from its local DB, never accepted from the webview) plus a path
//! that is **relative to that root**. The relative path is resolved against the
//! root, canonicalized, and asserted to stay inside the worktree, so a request
//! cannot read or write anywhere else, even through a symlink. The work runs on
//! whichever host owns the socket — local for local projects, the remote box for
//! SSH-bridged projects.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use pragma_constants::{DirEntry, FileChunk, FileContents, CONSTANTS};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process_env;
use crate::{CoreError, CoreResult};

/// Files larger than this are reported as `truncated` and never read into memory
/// or returned across the wire.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_QUERY_BYTES: usize = 256;
const MAX_SEARCH_ROOTS: usize = 64;
const MAX_SEARCH_RESULTS: usize = 100;
const MAX_SEARCH_ENTRIES: usize = 100_000;
const MAX_SEARCH_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEARCH_SNIPPET_BYTES: usize = 512;
const MIN_FILE_MATCH_SCORE: f64 = 0.45;
const MAX_CONCURRENT_SEARCHES: usize = if cfg!(test) { 1_024 } else { 2 };

static ACTIVE_SEARCHES: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One trusted worktree root included in a project palette search.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteSearchRoot {
    pub worktree_id: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaletteSearchMatch {
    worktree_id: String,
    path: String,
    kind: &'static str,
    score: f64,
    line: Option<u32>,
    column: Option<u32>,
    snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaletteSearchResponse {
    matches: Vec<PaletteSearchMatch>,
    truncated: bool,
}

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
    /// Returns the host's home directory, so a client can anchor user-scoped
    /// files (`~/.pragma/theme.json`) on whichever host owns the socket
    /// instead of guessing the path locally — a gateway reaching the daemon
    /// through an SSH bridge cannot know the remote user's home.
    HomeDir,
    /// Reads a file's contents.
    ReadFile { root: String, path: String },
    /// Overwrites a file with UTF-8 text.
    WriteFile {
        root: String,
        path: String,
        contents: String,
    },
    /// Lists file names (not directories) directly inside a worktree-relative
    /// directory, optionally restricted to the given lower-case extensions.
    /// Unlike [`FsRequest::ListDir`] this does not hide gitignored entries: it
    /// serves asset directories such as `.pragma/assets/sounds`, which projects
    /// routinely gitignore but users still expect to see listed.
    ListFileNames {
        root: String,
        path: String,
        extensions: Vec<String>,
    },
    /// Reads a worktree-relative file as base64, for the binary assets that
    /// [`FsRequest::ReadFile`] deliberately refuses to return as text.
    ReadBytes { root: String, path: String },
    /// Reads one base64 slice of a worktree-relative file. Unlike
    /// [`FsRequest::ReadBytes`] this has no whole-file size limit: the caller
    /// walks `offset` forward until [`FileChunk::eof`], so a file far larger
    /// than one protocol frame still crosses the wire.
    ReadBytesRange {
        root: String,
        path: String,
        offset: u64,
        length: u64,
    },
    /// Overwrites a worktree-relative file with base64-encoded bytes. Does not
    /// create missing parent directories.
    WriteBytes {
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
    /// Searches filenames and literal code lines across trusted worktree roots.
    PaletteSearch {
        search_id: String,
        roots: Vec<PaletteSearchRoot>,
        query: String,
        include_files: bool,
        include_code: bool,
        deadline_ms: u64,
    },
    /// Cancels an active palette search. Safe when the id is already complete.
    CancelPaletteSearch { search_id: String },
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
        FsRequest::HomeDir => to_value(home_dir()?),
        FsRequest::ReadFile { root, path } => to_value(read_file(&root, &path)?),
        FsRequest::WriteFile {
            root,
            path,
            contents,
        } => to_value(write_file(&root, &path, &contents)?),
        FsRequest::ListFileNames {
            root,
            path,
            extensions,
        } => to_value(list_file_names(&root, &path, &extensions)?),
        FsRequest::ReadBytes { root, path } => to_value(read_bytes(&root, &path)?),
        FsRequest::ReadBytesRange {
            root,
            path,
            offset,
            length,
        } => to_value(read_bytes_range(&root, &path, offset, length)?),
        FsRequest::WriteBytes {
            root,
            path,
            contents,
        } => to_value(write_bytes(&root, &path, &contents)?),
        FsRequest::Rename { root, from, to } => to_value(rename(&root, &from, &to)?),
        FsRequest::Delete { root, path } => to_value(delete(&root, &path)?),
        FsRequest::PaletteSearch {
            search_id,
            roots,
            query,
            include_files,
            include_code,
            deadline_ms,
        } => to_value(palette_search(
            &search_id,
            &roots,
            &query,
            include_files,
            include_code,
            deadline_ms,
        )?),
        FsRequest::CancelPaletteSearch { search_id } => {
            cancel_palette_search(&search_id);
            to_value(())
        }
    }
}

fn register_search(search_id: &str) -> CoreResult<Arc<AtomicBool>> {
    if search_id.is_empty() {
        return Err(CoreError::InvalidPayload(
            "search id is required".to_string(),
        ));
    }
    let mut active = ACTIVE_SEARCHES
        .lock()
        .map_err(|error| CoreError::Operation(error.to_string()))?;
    if let Some(previous) = active.remove(search_id) {
        previous.store(true, Ordering::Relaxed);
    }
    if active.len() >= MAX_CONCURRENT_SEARCHES {
        return Err(CoreError::Operation(
            "too many concurrent palette searches".to_string(),
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    active.insert(search_id.to_string(), Arc::clone(&cancelled));
    Ok(cancelled)
}

fn cancel_palette_search(search_id: &str) {
    if let Ok(active) = ACTIVE_SEARCHES.lock() {
        if let Some(cancelled) = active.get(search_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

fn unregister_search(search_id: &str) {
    if let Ok(mut active) = ACTIVE_SEARCHES.lock() {
        active.remove(search_id);
    }
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn palette_search(
    search_id: &str,
    roots: &[PaletteSearchRoot],
    query: &str,
    include_files: bool,
    include_code: bool,
    deadline_ms: u64,
) -> CoreResult<PaletteSearchResponse> {
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(CoreError::InvalidPayload(
            "query must contain 1 to 256 bytes".to_string(),
        ));
    }
    if roots.is_empty() || roots.len() > MAX_SEARCH_ROOTS {
        return Err(CoreError::InvalidPayload(
            "palette search requires 1 to 64 roots".to_string(),
        ));
    }

    let cancelled = register_search(search_id)?;
    let result = (|| {
        let deadline = Instant::now() + Duration::from_millis(deadline_ms.clamp(1, 5_000));
        let smart_case = query.chars().any(char::is_uppercase);
        let query_folded = (!smart_case).then(|| query.to_lowercase());
        let mut file_matches = Vec::new();
        let mut code_matches = Vec::new();
        let mut entries_seen = 0_usize;
        let mut bytes_seen = 0_u64;
        let mut truncated = false;

        'roots: for search_root in roots {
            let root = pragma_platform::path::canonicalize(&search_root.root)?;
            for relative in search_paths(&root) {
                if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                    truncated = true;
                    break 'roots;
                }
                entries_seen += 1;
                if entries_seen > MAX_SEARCH_ENTRIES {
                    truncated = true;
                    break 'roots;
                }
                let entry_path = root.join(&relative);
                let Ok(metadata) = entry_path.symlink_metadata() else {
                    continue;
                };
                if !metadata.file_type().is_file() {
                    continue;
                }
                let path = relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                let filename = relative
                    .file_name()
                    .map_or_else(String::new, |name| name.to_string_lossy().into_owned());

                if include_files && file_matches.len() < MAX_SEARCH_RESULTS {
                    if let Some(score) = fuzzy_score(&filename, &path, query) {
                        if score >= MIN_FILE_MATCH_SCORE {
                            file_matches.push(PaletteSearchMatch {
                                worktree_id: search_root.worktree_id.clone(),
                                path: path.clone(),
                                kind: "file",
                                score,
                                line: None,
                                column: None,
                                snippet: None,
                            });
                        }
                    }
                }

                if !include_code || code_matches.len() >= MAX_SEARCH_RESULTS {
                    continue;
                }
                if metadata.len() > MAX_READ_BYTES {
                    continue;
                }
                bytes_seen = bytes_seen.saturating_add(metadata.len());
                if bytes_seen > MAX_SEARCH_TOTAL_BYTES {
                    truncated = true;
                    break 'roots;
                }
                let Ok(bytes) = std::fs::read(entry_path) else {
                    continue;
                };
                let Ok(text) = String::from_utf8(bytes) else {
                    continue;
                };
                for (line_index, line) in text.lines().enumerate() {
                    let column = if smart_case {
                        line.find(query)
                    } else {
                        line.to_lowercase()
                            .find(query_folded.as_deref().unwrap_or(query))
                    };
                    let Some(byte_column) = column else {
                        continue;
                    };
                    // Byte offset -> 1-based char column so CodeMirror (UTF-16
                    // code units) lands on the right position for non-ASCII lines.
                    let char_column = line[..byte_column].chars().count() + 1;
                    code_matches.push(PaletteSearchMatch {
                        worktree_id: search_root.worktree_id.clone(),
                        path: path.clone(),
                        kind: "code",
                        score: 1.0,
                        line: Some(u32::try_from(line_index + 1).unwrap_or(u32::MAX)),
                        column: Some(u32::try_from(char_column).unwrap_or(u32::MAX)),
                        snippet: Some(bounded_snippet(line)),
                    });
                    if code_matches.len() >= MAX_SEARCH_RESULTS {
                        truncated = true;
                        break;
                    }
                }
                if file_matches.len() >= MAX_SEARCH_RESULTS
                    && code_matches.len() >= MAX_SEARCH_RESULTS
                {
                    truncated = true;
                    break 'roots;
                }
            }
        }
        let mut matches = file_matches;
        matches.extend(code_matches);
        matches.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.worktree_id.cmp(&b.worktree_id))
        });
        Ok(PaletteSearchResponse { matches, truncated })
    })();
    unregister_search(search_id);
    result
}

/// Returns tracked and untracked-but-not-ignored files for Git worktrees.
/// `git ls-files --exclude-standard` is authoritative for `.gitignore`,
/// `.git/info/exclude`, global excludes, and linked-worktree metadata. Non-Git
/// roots retain the ignore-walker fallback used before project Git adoption.
fn search_paths(root: &Path) -> Vec<PathBuf> {
    let git_paths = process_env::git()
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            output
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| PathBuf::from(String::from_utf8_lossy(path).into_owned()))
                .filter(|path| is_searchable_relative_path(path))
                .take(MAX_SEARCH_ENTRIES + 1)
                .collect()
        });
    git_paths.unwrap_or_else(|| {
        let mut builder = ignore::WalkBuilder::new(root);
        builder
            .standard_filters(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .parents(true)
            .hidden(false)
            .follow_links(false)
            .filter_entry(|entry| entry.file_name() != ".git");
        builder
            .build()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .is_some_and(|file_type| file_type.is_file())
            })
            .filter_map(|entry| entry.path().strip_prefix(root).ok().map(Path::to_path_buf))
            .filter(|path| is_searchable_relative_path(path))
            .take(MAX_SEARCH_ENTRIES + 1)
            .collect()
    })
}

fn is_searchable_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && !path.components().any(|component| match component {
            Component::ParentDir => true,
            Component::Normal(name) => name == ".git",
            Component::Prefix(_) | Component::RootDir | Component::CurDir => false,
        })
}

fn fuzzy_score(filename: &str, path: &str, query: &str) -> Option<f64> {
    let filename = filename.to_lowercase();
    let path = path.to_lowercase();
    let query = query.to_lowercase();
    if filename == query {
        return Some(1.0);
    }
    if filename.starts_with(&query) {
        return Some(0.9);
    }
    if filename.contains(&query) {
        return Some(0.8);
    }
    if path.contains(&query) {
        return Some(0.7);
    }
    let mut query_chars = query.chars();
    let mut wanted = query_chars.next()?;
    let mut matched = 0_usize;
    for character in filename.chars() {
        if character == wanted {
            matched += 1;
            let Some(next) = query_chars.next() else {
                let matched = u32::try_from(matched).unwrap_or(u32::MAX);
                let filename_len =
                    u32::try_from(filename.chars().count().max(1)).unwrap_or(u32::MAX);
                return Some(0.45 + 0.2 * (f64::from(matched) / f64::from(filename_len)));
            };
            wanted = next;
        }
    }
    None
}

fn bounded_snippet(line: &str) -> String {
    if line.len() <= MAX_SEARCH_SNIPPET_BYTES {
        return line.to_string();
    }
    let mut end = MAX_SEARCH_SNIPPET_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].to_string()
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
    let canonical_root = pragma_platform::path::canonicalize(root)?;
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
    // Must use the same canonicalizer as the root above: a verbatim-prefixed
    // path never `starts_with` a plain one, and the containment check would
    // reject every legitimate path on Windows.
    let mut resolved = pragma_platform::path::canonicalize(&ancestor)?;
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

/// The host's home directory, resolved through the platform seam so Windows
/// finds `USERPROFILE` rather than coming up empty.
fn home_dir() -> CoreResult<String> {
    pragma_platform::path::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::Operation("could not resolve the home directory".to_string()))
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

/// Lists file names directly inside a worktree-relative directory, keeping only
/// the given extensions when any are supplied. A missing directory lists empty
/// so callers can offer an asset folder before the user has created it.
pub fn list_file_names(root: &str, path: &str, extensions: &[String]) -> CoreResult<Vec<String>> {
    let dir = resolve_in_worktree(Path::new(root), path)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if extensions.is_empty() || has_extension(&name, extensions) {
            names.push(name);
        }
    }
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

fn has_extension(name: &str, extensions: &[String]) -> bool {
    Path::new(name)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .is_some_and(|extension| extensions.contains(&extension))
}

/// Reads a worktree-relative file as base64. Oversized files are rejected rather
/// than truncated, because a partial binary asset is useless to the caller.
pub fn read_bytes(root: &str, path: &str) -> CoreResult<String> {
    let target = resolve_in_worktree(Path::new(root), path)?;
    let byte_size = std::fs::metadata(&target)?.len();
    if byte_size > MAX_READ_BYTES {
        return Err(CoreError::InvalidPayload(format!(
            "{path} is larger than the {MAX_READ_BYTES} byte read limit"
        )));
    }
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        std::fs::read(&target)?,
    ))
}

/// Reads one base64 slice of a worktree-relative file, starting at `offset` and
/// covering at most `length` bytes. `length` is clamped to the shared chunk cap
/// so a single response always fits inside one protocol frame even after base64
/// expands it by 4/3; the caller loops on `offset` to read a whole file.
pub fn read_bytes_range(root: &str, path: &str, offset: u64, length: u64) -> CoreResult<FileChunk> {
    if length == 0 {
        return Err(CoreError::InvalidPayload(
            "length must be greater than zero".to_string(),
        ));
    }
    let length = length.min(CONSTANTS.files.chunk_bytes.get());
    let target = resolve_in_worktree(Path::new(root), path)?;
    let mut file = std::fs::File::open(&target)?;
    let byte_size = file.metadata()?.len();
    if offset >= byte_size {
        return Ok(FileChunk {
            base64: String::new(),
            offset,
            byte_size,
            eof: true,
        });
    }
    let take = length.min(byte_size - offset);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0_u8; usize::try_from(take).unwrap_or(usize::MAX)];
    file.read_exact(&mut bytes)?;
    Ok(FileChunk {
        base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        offset,
        byte_size,
        eof: offset + take >= byte_size,
    })
}

/// Overwrites a worktree-relative file with base64-encoded bytes. Does not create
/// missing parent directories.
fn write_bytes(root: &str, path: &str, contents: &str) -> CoreResult<()> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, contents)
        .map_err(|error| CoreError::InvalidPayload(format!("invalid base64 contents: {error}")))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(CoreError::InvalidPayload(format!(
            "contents exceed the {MAX_READ_BYTES} byte write limit"
        )));
    }
    let target = resolve_in_worktree(Path::new(root), path)?;
    std::fs::write(&target, bytes)?;
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

    use super::{
        gitignored, palette_search, resolve_in_worktree, PaletteSearchRoot, MAX_READ_BYTES,
    };

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
        // Same canonicalizer as the code under test: `std::fs`'s keeps the `\\?\`
        // verbatim prefix on Windows, which `resolve_in_worktree` strips.
        assert_eq!(
            root,
            pragma_platform::path::canonicalize(dir.path()).expect("canon")
        );
    }

    #[test]
    fn rejects_symlink_escape() {
        let dir = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside tempdir");
        std::fs::write(outside.path().join("secret.txt"), "secret").expect("write secret");
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
        #[cfg(windows)]
        {
            // Symlink creation needs Developer Mode or admin. Without that
            // privilege no link exists, so the escape this test guards is
            // unreachable — skip rather than assert a vacuous pass.
            if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
                return;
            }
        }
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
    fn home_dir_op_returns_an_absolute_host_path() {
        let value = super::handle(serde_json::json!({ "op": "homeDir" })).expect("homeDir");
        let home = value.as_str().expect("home dir string");
        assert!(std::path::Path::new(home).is_absolute());
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

    #[test]
    fn lists_asset_file_names_by_extension_including_gitignored_ones() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::write(dir.path().join(".gitignore"), ".pragma/\n").expect("write gitignore");
        let sounds = dir.path().join(".pragma/assets/sounds");
        std::fs::create_dir_all(&sounds).expect("mkdir sounds");
        std::fs::write(sounds.join("Chime.WAV"), "riff").expect("write wav");
        std::fs::write(sounds.join("alert.mp3"), "id3").expect("write mp3");
        std::fs::write(sounds.join("notes.txt"), "text").expect("write txt");
        std::fs::create_dir(sounds.join("nested")).expect("mkdir nested");

        let root = dir.path().to_string_lossy().into_owned();
        let names = super::list_file_names(
            &root,
            ".pragma/assets/sounds",
            &["wav".to_string(), "mp3".to_string()],
        )
        .expect("list");

        assert_eq!(
            names,
            vec!["alert.mp3".to_string(), "Chime.WAV".to_string()]
        );
        // A directory that does not exist yet lists empty rather than failing.
        assert!(super::list_file_names(&root, ".pragma/assets/missing", &[])
            .expect("list missing")
            .is_empty());
    }

    #[test]
    fn round_trips_binary_assets_as_base64() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().into_owned();
        let bytes = [0_u8, 159, 146, 150];
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);

        super::write_bytes(&root, "clip.wav", &encoded).expect("write bytes");

        assert_eq!(super::read_bytes(&root, "clip.wav").expect("read"), encoded);
        assert_eq!(std::fs::read(dir.path().join("clip.wav")).unwrap(), bytes);
        assert!(super::write_bytes(&root, "clip.wav", "not base64!").is_err());
    }

    #[test]
    fn reads_binary_files_chunk_by_chunk_past_the_whole_file_cap() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().into_owned();
        // Deliberately larger than MAX_READ_BYTES, which `read_bytes` refuses.
        let bytes: Vec<u8> = (0..=u8::MAX)
            .cycle()
            .take(usize::try_from(MAX_READ_BYTES).expect("cap fits usize") + 1_024)
            .collect();
        std::fs::write(dir.path().join("doc.pdf"), &bytes).expect("write pdf");
        assert!(super::read_bytes(&root, "doc.pdf").is_err());

        let mut assembled: Vec<u8> = Vec::new();
        let mut offset = 0_u64;
        loop {
            let chunk =
                super::read_bytes_range(&root, "doc.pdf", offset, u64::MAX).expect("read chunk");
            assert_eq!(chunk.offset, offset);
            assert_eq!(chunk.byte_size, bytes.len() as u64);
            assembled.extend(
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &chunk.base64)
                    .expect("decode chunk"),
            );
            offset = assembled.len() as u64;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(assembled, bytes);

        // Reading at or past the end terminates instead of erroring, and a
        // zero-length request is rejected so a caller cannot spin forever.
        let past_end =
            super::read_bytes_range(&root, "doc.pdf", bytes.len() as u64, 16).expect("read past");
        assert!(past_end.eof && past_end.base64.is_empty());
        assert!(super::read_bytes_range(&root, "doc.pdf", 0, 0).is_err());
    }

    #[test]
    fn palette_search_returns_relative_file_and_code_matches() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::create_dir(dir.path().join("src")).expect("mkdir");
        std::fs::write(
            dir.path().join("src/CommandPalette.tsx"),
            "const commandPalette = true;\n",
        )
        .expect("write");
        let response = palette_search(
            "search-relative",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: dir.path().to_string_lossy().into_owned(),
            }],
            "commandPalette",
            true,
            true,
            1_000,
        )
        .expect("search");
        assert!(response
            .matches
            .iter()
            .any(|item| { item.path == "src/CommandPalette.tsx" && item.kind == "file" }));
        assert!(response.matches.iter().any(|item| {
            item.path == "src/CommandPalette.tsx" && item.kind == "code" && item.line == Some(1)
        }));
    }

    #[test]
    fn palette_search_excludes_gitignored_file_and_code_matches() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::write(dir.path().join(".gitignore"), "ignored/\n").expect("write gitignore");
        std::fs::create_dir(dir.path().join("ignored")).expect("mkdir ignored");
        std::fs::write(
            dir.path().join("ignored/README.md"),
            "gitignored_search_sentinel\n",
        )
        .expect("write ignored file");
        std::fs::write(dir.path().join("README.md"), "kept content\n").expect("write kept file");

        let response = palette_search(
            "search-gitignored",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: dir.path().to_string_lossy().into_owned(),
            }],
            "gitignored_search_sentinel",
            true,
            true,
            1_000,
        )
        .expect("search");

        assert!(response.matches.is_empty());
    }

    #[test]
    fn palette_search_excludes_gitignored_files_in_linked_worktree() {
        let dir = tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        let worktree = dir.path().join("worktree");
        std::fs::create_dir(&repo).expect("mkdir repo");
        git_init(&repo);
        let commit = Command::new("git")
            .args([
                "-c",
                "user.name=Pragma Test",
                "-c",
                "user.email=test@pragma.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ])
            .current_dir(&repo)
            .output()
            .expect("git commit");
        assert!(commit.status.success());
        let add_worktree = Command::new("git")
            .args(["worktree", "add", "--detach"])
            .arg(&worktree)
            .current_dir(&repo)
            .output()
            .expect("git worktree add");
        assert!(add_worktree.status.success());
        std::fs::write(repo.join(".git/info/exclude"), "ignored/\n").expect("write exclude");
        std::fs::create_dir(worktree.join("ignored")).expect("mkdir ignored");
        std::fs::write(
            worktree.join("ignored/README.md"),
            "linked_worktree_ignored_sentinel\n",
        )
        .expect("write ignored file");

        let response = palette_search(
            "search-linked-worktree-gitignored",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: worktree.to_string_lossy().into_owned(),
            }],
            "linked_worktree_ignored_sentinel",
            true,
            true,
            1_000,
        )
        .expect("search");

        assert!(response.matches.is_empty());
        let git_pointer = palette_search(
            "search-linked-worktree-dot-git",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: worktree.to_string_lossy().into_owned(),
            }],
            "gitdir:",
            true,
            true,
            1_000,
        )
        .expect("search git pointer");
        assert!(git_pointer.matches.is_empty());
    }

    #[test]
    fn palette_search_honors_git_info_exclude() {
        let dir = tempdir().expect("tempdir");
        git_init(dir.path());
        std::fs::write(dir.path().join(".git/info/exclude"), "generated.txt\n")
            .expect("write exclude");
        std::fs::write(
            dir.path().join("generated.txt"),
            "git_info_exclude_sentinel\n",
        )
        .expect("write ignored file");

        let response = palette_search(
            "search-git-info-exclude",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: dir.path().to_string_lossy().into_owned(),
            }],
            "git_info_exclude_sentinel",
            true,
            true,
            1_000,
        )
        .expect("search");

        assert!(response.matches.is_empty());
    }

    #[test]
    fn palette_search_never_scans_dot_git() {
        let dir = tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join(".git")).expect("mkdir .git");
        std::fs::write(dir.path().join(".git/config"), "dot_git_search_sentinel\n")
            .expect("write git metadata");

        let response = palette_search(
            "search-dot-git",
            &[PaletteSearchRoot {
                worktree_id: "worktree".to_string(),
                root: dir.path().to_string_lossy().into_owned(),
            }],
            "dot_git_search_sentinel",
            true,
            true,
            1_000,
        )
        .expect("search");

        assert!(response.matches.is_empty());
    }

    #[test]
    fn palette_code_search_uses_smart_case() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(dir.path().join("code.rs"), "Palette palette\n").expect("write");
        let roots = [PaletteSearchRoot {
            worktree_id: "worktree".to_string(),
            root: dir.path().to_string_lossy().into_owned(),
        }];
        let lower = palette_search("search-lower", &roots, "palette", false, true, 1_000)
            .expect("lower search");
        let upper = palette_search("search-upper", &roots, "Palette", false, true, 1_000)
            .expect("upper search");
        assert_eq!(lower.matches[0].column, Some(1));
        assert_eq!(upper.matches[0].column, Some(1));
    }
}
