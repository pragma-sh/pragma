//! AI integration: a thin Rust proxy over the `pragma-ai` sidecar (a
//! Bun-compiled binary that runs the Node-only pi coding-agent SDK out of
//! process). The sidecar speaks newline-delimited JSON; this module spawns it
//! per operation, feeds stdin, and parses the result.
//!
//! In a debug build the sidecar is run from source via `bun`
//! (`packages/ai-helpers/src/cli.ts`); a release build runs the staged
//! `pragma-ai` binary beside the app executable (see `stage-daemon-sidecar.sh`
//! and `tauri.conf.json` `externalBin`).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::pty::{sidecar_executable, workspace_root};

/// `settings` key for the "user dismissed AI setup" flag.
const SETUP_DISMISSED_KEY: &str = "ai.setupDismissed";

/// One authorization method offered on the AI setup screen.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthMethod {
    pub provider: String,
    pub label: String,
    pub kind: String,
    pub featured: bool,
}

/// Whether AI features can run, plus which providers are signed in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub available: bool,
    pub signed_in: Vec<String>,
}

/// AI-generated pull request title and markdown body.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPullRequestDraft {
    pub title: String,
    pub body: String,
}

/// Result of committing the dirty worktree and drafting a pull request.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitAndPullRequestDraft {
    pub title: String,
    pub body: String,
    pub commit_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitPlanContext {
    allowed_paths: Vec<String>,
    status: String,
    diff_stat: String,
    worktree_diff: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCommitPlan {
    commits: Vec<AiCommitPlanCommit>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCommitPlanCommit {
    message: String,
    paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestContext {
    git_log: String,
    diff_stat: String,
    committed_diff: String,
}

/// Live OAuth login sessions, keyed by a frontend-supplied id. Holds the child
/// (for cancellation) and its stdin (to answer interactive prompts). Cloning
/// shares the same map so the reader thread can deregister a finished session.
#[derive(Default, Clone)]
pub struct LoginRegistry(Arc<Mutex<HashMap<String, LoginHandle>>>);

struct LoginHandle {
    child: Child,
    stdin: ChildStdin,
}

/// Build the base sidecar command (no subcommand args yet).
fn sidecar_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = crate::process_env::command("bun");
        command.arg(workspace_root().join("packages/ai-helpers/src/cli.ts"));
        command.current_dir(workspace_root());
        command
    } else {
        let path = sidecar_executable("pragma-ai");
        crate::process_env::command(&path.to_string_lossy())
    }
}

/// Run a one-shot sidecar command, optionally writing `stdin_data`, and return
/// the final NDJSON event. Maps an `error` event to an `AppError`.
fn run_oneshot(args: &[&str], stdin_data: Option<&str>) -> AppResult<Value> {
    let mut command = sidecar_command();
    command.args(args);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = command.spawn()?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data.as_bytes())?;
        }
    }
    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            AppError::Ai(format!("ai sidecar produced no output ({})", stderr.trim()))
        })?;

    let value: Value = serde_json::from_str(last)?;
    if value.get("type").and_then(Value::as_str) == Some("error") {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("ai sidecar error");
        return Err(AppError::Ai(message.to_string()));
    }
    Ok(value)
}

fn parse_status(value: &Value) -> AiStatus {
    AiStatus {
        available: value
            .get("available")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        signed_in: value
            .get("signedIn")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Whether at least one authenticated provider exposes a usable model.
#[tauri::command]
pub async fn ai_status() -> AppResult<AiStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        run_oneshot(&["status"], None).map(|v| parse_status(&v))
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// All authorization methods to present on the setup screen.
#[tauri::command]
pub async fn ai_auth_methods() -> AppResult<Vec<AiAuthMethod>> {
    tauri::async_runtime::spawn_blocking(|| {
        let value = run_oneshot(&["methods"], None)?;
        let methods = value
            .get("methods")
            .cloned()
            .ok_or_else(|| AppError::Ai("ai sidecar returned no methods".to_string()))?;
        serde_json::from_value::<Vec<AiAuthMethod>>(methods).map_err(AppError::from)
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Store an API key for a provider, returning the refreshed status.
#[tauri::command]
pub async fn ai_set_api_key(provider: String, api_key: String) -> AppResult<AiStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        run_oneshot(&["set-key", "--provider", &provider], Some(&api_key)).map(|v| parse_status(&v))
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Remove all stored credentials for a provider.
#[tauri::command]
pub async fn ai_logout(provider: String) -> AppResult<AiStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        run_oneshot(&["logout", "--provider", &provider], None).map(|v| parse_status(&v))
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Whether the user has dismissed AI setup.
#[tauri::command]
pub fn ai_setup_dismissed(db: State<'_, Db>) -> AppResult<bool> {
    Ok(db.setting(SETUP_DISMISSED_KEY)?.as_deref() == Some("true"))
}

/// Persist the "AI setup dismissed" preference.
#[tauri::command]
pub fn set_ai_setup_dismissed(db: State<'_, Db>, dismissed: bool) -> AppResult<()> {
    db.set_setting(
        SETUP_DISMISSED_KEY,
        if dismissed { "true" } else { "false" },
    )
}

/// Generate a commit message from a worktree's staged changes using a quick
/// model. Errors when nothing is staged or no AI provider is available.
#[tauri::command]
pub async fn ai_generate_commit_message(
    db: State<'_, Db>,
    worktree_id: String,
) -> AppResult<String> {
    let worktree = db.worktree(&worktree_id)?;
    let cwd = worktree.path;

    tauri::async_runtime::spawn_blocking(move || {
        let diff = staged_diff(&cwd)?;
        if diff.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "No staged changes to generate a commit message from.".to_string(),
            ));
        }
        let value = run_oneshot(&["commit-message", "--cwd", &cwd], Some(&diff))?;
        value
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AppError::Ai("ai sidecar returned no message".to_string()))
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Generate a pull request title and markdown body from the branch's committed
/// changes using a standard model. The sidecar leaves tools enabled so the agent
/// can inspect changed code when the git log/diff are not enough context.
#[tauri::command]
pub async fn ai_generate_pull_request_draft(
    db: State<'_, Db>,
    worktree_id: String,
) -> AppResult<AiPullRequestDraft> {
    let worktree = db.worktree(&worktree_id)?;
    let Some(parent_id) = worktree.parent_id.as_deref() else {
        return Err(AppError::InvalidInput(
            "No parent branch to generate a pull request from.".to_string(),
        ));
    };
    let parent = db.worktree(parent_id)?;
    let cwd = worktree.path;
    let parent_branch = parent.branch;
    let parent_path = parent.path;

    tauri::async_runtime::spawn_blocking(move || {
        let context = pull_request_context(&cwd, &parent_branch, Some(&parent_path))?;
        if context.git_log.trim().is_empty() && context.committed_diff.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "No committed changes to generate a pull request from.".to_string(),
            ));
        }
        let stdin = serde_json::to_string(&context)?;
        let value = run_oneshot(&["pull-request", "--cwd", &cwd], Some(&stdin))?;
        serde_json::from_value::<AiPullRequestDraft>(value).map_err(AppError::from)
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

/// Generate a logical commit plan for all dirty worktree changes, create those
/// commits, then generate a pull request title/body from the resulting branch.
#[tauri::command]
pub async fn ai_commit_all_and_generate_pull_request_draft(
    db: State<'_, Db>,
    locks: State<'_, GitLocks>,
    worktree_id: String,
) -> AppResult<AiCommitAndPullRequestDraft> {
    let worktree = db.worktree(&worktree_id)?;
    let Some(parent_id) = worktree.parent_id.as_deref() else {
        return Err(AppError::InvalidInput(
            "No parent branch to generate a pull request from.".to_string(),
        ));
    };
    let parent = db.worktree(parent_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let cwd = worktree.path;
    let parent_branch = parent.branch;
    let parent_path = parent.path;

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock()?;
        let allowed_paths = changed_paths(&cwd)?;
        if allowed_paths.is_empty() {
            return Err(AppError::InvalidInput("No changes to commit.".to_string()));
        }

        let context = CommitPlanContext {
            allowed_paths: allowed_paths.clone(),
            status: git_output(&cwd, &["status", "--short", "--untracked-files=normal"])
                .unwrap_or_default(),
            diff_stat: git_output(&cwd, &["diff", "--stat", "--find-renames", "HEAD"])
                .unwrap_or_default(),
            worktree_diff: git_output(&cwd, &["diff", "--find-renames", "HEAD"])
                .unwrap_or_default(),
        };
        let stdin = serde_json::to_string(&context)?;
        let value = run_oneshot(&["commit-plan", "--cwd", &cwd], Some(&stdin))?;
        let plan = serde_json::from_value::<AiCommitPlan>(value).map_err(AppError::from)?;
        let commits = normalize_commit_plan(plan, &allowed_paths)?;

        unstage_everything(&cwd)?;
        let mut commit_count = 0;
        for commit in &commits {
            stage_paths(&cwd, &commit.paths)?;
            if staged_diff(&cwd)?.trim().is_empty() {
                continue;
            }
            commit_index(&cwd, &commit.message)?;
            commit_count += 1;
            unstage_everything(&cwd)?;
        }

        let remaining = changed_paths(&cwd)?;
        if !remaining.is_empty() {
            return Err(AppError::Git(format!(
                "failed to commit all changes; remaining paths: {}",
                remaining.join(", ")
            )));
        }

        let context = pull_request_context(&cwd, &parent_branch, Some(&parent_path))?;
        let stdin = serde_json::to_string(&context)?;
        let value = run_oneshot(&["pull-request", "--cwd", &cwd], Some(&stdin))?;
        let draft = serde_json::from_value::<AiPullRequestDraft>(value).map_err(AppError::from)?;
        Ok(AiCommitAndPullRequestDraft {
            title: draft.title,
            body: draft.body,
            commit_count,
        })
    })
    .await
    .map_err(|error| AppError::Ai(error.to_string()))?
}

fn staged_diff(cwd: &str) -> AppResult<String> {
    git_output(cwd, &["diff", "--cached"])
}

fn normalize_commit_plan(
    plan: AiCommitPlan,
    allowed_paths: &[String],
) -> AppResult<Vec<AiCommitPlanCommit>> {
    let allowed: HashSet<&str> = allowed_paths.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut commits = Vec::new();

    for commit in plan.commits {
        let message = commit.message.trim().to_string();
        if message.is_empty() {
            return Err(AppError::Ai(
                "ai sidecar returned a commit with no message".to_string(),
            ));
        }
        let mut paths = Vec::new();
        for path in commit.paths {
            let path = path.trim().to_string();
            if !allowed.contains(path.as_str()) {
                return Err(AppError::Ai(format!(
                    "ai sidecar returned a path outside the changed set: {path}"
                )));
            }
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        if !paths.is_empty() {
            commits.push(AiCommitPlanCommit { message, paths });
        }
    }

    let missing: Vec<String> = allowed_paths
        .iter()
        .filter(|path| !seen.contains(path.as_str()))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let Some(last) = commits.last_mut() else {
            return Err(AppError::Ai(
                "ai sidecar returned no usable commit plan".to_string(),
            ));
        };
        last.paths.extend(missing);
    }

    if commits.is_empty() {
        return Err(AppError::Ai(
            "ai sidecar returned no usable commit plan".to_string(),
        ));
    }
    Ok(commits)
}

fn changed_paths(cwd: &str) -> AppResult<Vec<String>> {
    let mut paths = Vec::new();
    for output in [
        git_output_bytes(cwd, &["diff", "--name-only", "-z", "HEAD"]),
        git_output_bytes(cwd, &["ls-files", "--others", "--exclude-standard", "-z"]),
    ] {
        for path in output?
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = String::from_utf8_lossy(path).into_owned();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

fn unstage_everything(cwd: &str) -> AppResult<()> {
    git_run(cwd, &["reset", "-q", "HEAD", "--", "."])
}

fn stage_paths(cwd: &str, paths: &[String]) -> AppResult<()> {
    let root = Path::new(cwd);
    for path in paths {
        crate::fs::resolve_in_worktree(root, path)?;
    }
    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    git_run_owned(cwd, &args)
}

fn commit_index(cwd: &str, message: &str) -> AppResult<()> {
    git_run(cwd, &["commit", "-m", message])
}

fn pull_request_context(
    cwd: &str,
    parent_branch: &str,
    parent_path: Option<&str>,
) -> AppResult<PullRequestContext> {
    let merge_base = pull_request_merge_base(cwd, parent_branch, parent_path)?;
    let range = format!("{merge_base}..HEAD");
    Ok(PullRequestContext {
        git_log: git_output(cwd, &["log", "--reverse", "--format=%h %s%n%b", &range])?,
        diff_stat: git_output(
            cwd,
            &["diff", "--stat", "--find-renames", &merge_base, "HEAD"],
        )?,
        committed_diff: git_output(cwd, &["diff", "--find-renames", &merge_base, "HEAD"])?,
    })
}

fn pull_request_merge_base(
    cwd: &str,
    parent_branch: &str,
    parent_path: Option<&str>,
) -> AppResult<String> {
    for candidate in base_ref_candidates(parent_branch, parent_path)? {
        if let Some(merge_base) = git_output_optional(cwd, &["merge-base", "HEAD", &candidate])? {
            let merge_base = merge_base.trim().to_string();
            if !merge_base.is_empty() {
                return Ok(merge_base);
            }
        }
    }
    Err(AppError::InvalidInput(format!(
        "Unable to determine the branch merge-base for {parent_branch}."
    )))
}

fn base_ref_candidates(parent_branch: &str, parent_path: Option<&str>) -> AppResult<Vec<String>> {
    let mut candidates = Vec::new();
    for candidate in [
        parent_branch.to_string(),
        format!("refs/heads/{parent_branch}"),
        format!("origin/{parent_branch}"),
        format!("refs/remotes/origin/{parent_branch}"),
    ] {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    if let Some(path) = parent_path {
        if let Some(parent_head) = git_output_optional(path, &["rev-parse", "HEAD"])? {
            let parent_head = parent_head.trim().to_string();
            if !parent_head.is_empty() && !candidates.contains(&parent_head) {
                candidates.push(parent_head);
            }
        }
    }
    Ok(candidates)
}

fn git_output(cwd: &str, args: &[&str]) -> AppResult<String> {
    git_output_bytes(cwd, args).map(|stdout| String::from_utf8_lossy(&stdout).to_string())
}

fn git_output_bytes(cwd: &str, args: &[&str]) -> AppResult<Vec<u8>> {
    let output = crate::process_env::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(output.stdout)
}

fn git_run(cwd: &str, args: &[&str]) -> AppResult<()> {
    let output = crate::process_env::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

fn git_run_owned(cwd: &str, args: &[String]) -> AppResult<()> {
    let output = crate::process_env::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

fn git_output_optional(cwd: &str, args: &[&str]) -> AppResult<Option<String>> {
    let output = crate::process_env::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()))
}

/// Start an interactive OAuth login. Events (`auth`, `device-code`, `progress`,
/// `prompt`, `select`, `result`, `error`) stream over `on_event`; answer prompts
/// with [`ai_login_respond`] and abort with [`ai_login_cancel`], both keyed by
/// `id`.
#[tauri::command]
pub fn ai_login(
    registry: State<'_, LoginRegistry>,
    id: String,
    provider: String,
    on_event: Channel<Value>,
) -> AppResult<()> {
    let mut command = sidecar_command();
    command.args(["login", "--provider", &provider]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Ai("failed to capture ai sidecar stdout".to_string()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Ai("failed to capture ai sidecar stdin".to_string()))?;

    registry
        .0
        .lock()?
        .insert(id.clone(), LoginHandle { child, stdin });

    let map = registry.0.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)
                .unwrap_or_else(|_| json!({ "type": "log", "line": trimmed }));
            let is_terminal = matches!(
                value.get("type").and_then(Value::as_str),
                Some("result" | "error")
            );
            let _ = on_event.send(value);
            if is_terminal {
                break;
            }
        }
        // Deregister and reap the child so a finished login does not leave a
        // zombie on Unix. Take the handle out under the lock, then `wait()`
        // outside it (the sidecar has already exited or is exiting).
        let handle = map.lock().ok().and_then(|mut guard| guard.remove(&id));
        if let Some(mut handle) = handle {
            let _ = handle.child.wait();
        }
    });

    Ok(())
}

/// Answer a pending interactive prompt for an in-flight login.
#[tauri::command]
pub fn ai_login_respond(
    registry: State<'_, LoginRegistry>,
    id: String,
    value: Option<String>,
    cancelled: bool,
) -> AppResult<()> {
    let mut guard = registry.0.lock()?;
    if let Some(handle) = guard.get_mut(&id) {
        let payload = json!({ "value": value, "cancelled": cancelled });
        writeln!(handle.stdin, "{payload}")?;
        handle.stdin.flush()?;
    }
    Ok(())
}

/// Abort an in-flight login and drop its session.
#[tauri::command]
pub fn ai_login_cancel(registry: State<'_, LoginRegistry>, id: String) -> AppResult<()> {
    if let Some(mut handle) = registry.0.lock()?.remove(&id) {
        let _ = handle.child.kill();
        // Reap the killed child so it does not linger as a zombie until the
        // Tauri process exits.
        let _ = handle.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::{parse_status, pull_request_context};
    use serde_json::json;

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn parse_status_reads_available_and_signed_in() {
        let status = parse_status(&json!({
            "type": "status",
            "available": true,
            "signedIn": ["anthropic", "openrouter"],
        }));
        assert!(status.available);
        assert_eq!(status.signed_in, vec!["anthropic", "openrouter"]);
    }

    #[test]
    fn parse_status_defaults_missing_fields() {
        let status = parse_status(&json!({ "type": "status" }));
        assert!(!status.available);
        assert!(status.signed_in.is_empty());
    }

    #[test]
    fn pull_request_context_falls_back_to_origin_parent_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "Test User"]);

        std::fs::write(root.join("base.txt"), "base\n").expect("write base");
        run_git(root, &["add", "base.txt"]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run_git(root, &["checkout", "-b", "feature"]);

        let _ = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["branch", "-D", "main"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["branch", "-D", "master"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        std::fs::write(root.join("feature.txt"), "feature\n").expect("write feature");
        run_git(root, &["add", "feature.txt"]);
        run_git(root, &["commit", "-m", "add feature"]);

        let context = pull_request_context(root.to_str().expect("utf-8 path"), "main", None)
            .expect("pr context");

        assert!(context.git_log.contains("add feature"));
        assert!(context.diff_stat.contains("feature.txt"));
        assert!(context.committed_diff.contains("feature.txt"));
    }

    #[test]
    fn pull_request_context_falls_back_to_parent_worktree_head() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = dir.path().join("parent");
        let child = dir.path().join("child");
        std::fs::create_dir(&parent).expect("create parent");

        run_git(&parent, &["init"]);
        run_git(&parent, &["config", "user.email", "test@example.com"]);
        run_git(&parent, &["config", "user.name", "Test User"]);
        std::fs::write(parent.join("base.txt"), "base\n").expect("write base");
        run_git(&parent, &["add", "base.txt"]);
        run_git(&parent, &["commit", "-m", "base"]);
        run_git(
            &parent,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                child.to_str().expect("utf-8 child path"),
                "HEAD",
            ],
        );

        std::fs::write(child.join("feature.txt"), "feature\n").expect("write feature");
        run_git(&child, &["add", "feature.txt"]);
        run_git(&child, &["commit", "-m", "add feature"]);

        let context = pull_request_context(
            child.to_str().expect("utf-8 child path"),
            "missing-main",
            Some(parent.to_str().expect("utf-8 parent path")),
        )
        .expect("pr context");

        assert!(context.git_log.contains("add feature"));
        assert!(context.diff_stat.contains("feature.txt"));
        assert!(context.committed_diff.contains("feature.txt"));
    }
}
