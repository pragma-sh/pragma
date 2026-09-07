//! GitHub on the host: the token, and the operations that need it.
//!
//! The token lives here, beside the socket, rather than in the desktop app's
//! data directory — because the point of the host owning it is that a phone can
//! open a pull request with no desktop window running. It is a plaintext file
//! with owner-only permissions (`0600` on Unix, an owner-only ACL on Windows,
//! both through `pragma_platform::perms`), the same model the `gh` CLI uses.
//! The OS keychain is deliberately avoided: keychain items are bound to an
//! app's code signature, which changes on every unsigned rebuild.
//!
//! The token never crosses the gateway. Clients ask this module to *do* things;
//! the answers carry pull requests and logins, never credentials.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pragma_constants::GitHubPullRequest;
use pragma_core::git::{GitRequest, GithubRepoInfo};
use pragma_platform::perms;
use serde_json::{json, Value};
use thiserror::Error;

use crate::sidecar::run_oneshot;

/// Filename, beside the socket, holding the GitHub token.
const TOKEN_FILE_NAME: &str = "github-token";
const SIDECAR_NAME: &str = "pragma-github";
const SIDECAR_DEV_ENTRY: &str = "packages/github-helpers/src/cli.ts";
/// Environment variable the sidecar reads the token from. An environment
/// variable rather than an argument: arguments are visible in a process listing.
const TOKEN_ENV: &str = "PRAGMA_GITHUB_TOKEN";

#[derive(Debug, Error)]
pub enum GithubError {
    #[error("invalid github request: {0}")]
    InvalidRequest(String),
    #[error("not signed in to GitHub")]
    NotAuthenticated,
    #[error("github operation failed: {0}")]
    Operation(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

/// A publish that already happened, so a retry replays it instead of repeating it.
struct CompletedPublish {
    request_id: String,
    pull_request: GitHubPullRequest,
}

/// The host's GitHub credential and the operations that use it.
pub struct GithubHost {
    token_path: PathBuf,
    /// Publishes already completed, keyed by the caller's request id.
    ///
    /// Pushing can succeed and the create response be lost — a dropped tunnel,
    /// a backgrounded phone — often enough that a blind retry would open a
    /// second pull request for the same branch.
    completed: Mutex<Vec<CompletedPublish>>,
}

/// How many completed publishes to remember. A retry follows its original
/// within seconds; this only has to outlive that.
const COMPLETED_LIMIT: usize = 32;

impl GithubHost {
    pub fn new(server_dir: &Path) -> Self {
        Self {
            token_path: server_dir.join(TOKEN_FILE_NAME),
            completed: Mutex::new(Vec::new()),
        }
    }

    /// Handles one `github` RPC payload.
    pub fn handle_rpc(&self, payload: &Value) -> Result<Value, GithubError> {
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match action {
            "status" => Ok(self.status()),
            "setToken" => self.set_token(payload),
            "clearToken" => {
                self.clear_token()?;
                Ok(json!({ "ok": true }))
            }
            "pullRequest" => self.pull_request(payload),
            "publishPullRequest" => self.publish_pull_request(payload),
            other => Err(GithubError::InvalidRequest(format!(
                "unknown github action: {other}"
            ))),
        }
    }

    /// Whether a token is stored, and who it belongs to.
    ///
    /// The login is looked up rather than remembered, so a token revoked on
    /// github.com reports as signed out here instead of showing a stale name.
    fn status(&self) -> Value {
        let Some(token) = self.token() else {
            return json!({ "authenticated": false, "login": null });
        };
        match Self::run_sidecar(&token, &["viewer"], None) {
            Ok(value) => json!({
                "authenticated": true,
                "login": value.get("login").and_then(Value::as_str),
            }),
            // A token GitHub no longer accepts — revoked on the website, or
            // expired — is reported as signed out rather than as a stale name.
            Err(error) => json!({
                "authenticated": false,
                "login": null,
                "error": error.to_string(),
            }),
        }
    }

    /// Stores a token obtained by whichever flow the client ran.
    fn set_token(&self, payload: &Value) -> Result<Value, GithubError> {
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| GithubError::InvalidRequest("token is required".to_string()))?;
        self.write_token(token)?;
        Ok(self.status())
    }

    /// Looks up the pull request for a worktree's branch.
    fn pull_request(&self, payload: &Value) -> Result<Value, GithubError> {
        let root = required_str(payload, "root")?;
        let token = self.require_token()?;
        let info = repo_info(&root)?;
        let Some((owner, repo)) = owner_repo(&info.remote_url) else {
            // Not a GitHub remote. Not an error: plenty of projects are not on
            // GitHub, and they simply have no pull request.
            return Ok(json!({ "pullRequest": null }));
        };
        let value = Self::run_sidecar(
            &token,
            &[
                "pull-request",
                "--owner",
                &owner,
                "--repo",
                &repo,
                "--head",
                &info.head_branch,
            ],
            None,
        )?;
        Ok(json!({ "pullRequest": value.get("pullRequest").cloned().unwrap_or(Value::Null) }))
    }

    /// Pushes the branch and creates its pull request.
    ///
    /// Push and create are separate effects, and only the second is replayed
    /// from the idempotency record: a push is idempotent on its own, while
    /// creating twice would open a second pull request.
    fn publish_pull_request(&self, payload: &Value) -> Result<Value, GithubError> {
        let request_id = required_str(payload, "requestId")?;
        if let Some(existing) = self.completed_publish(&request_id)? {
            return Ok(json!({ "pullRequest": existing }));
        }
        let root = required_str(payload, "root")?;
        let title = required_str(payload, "title")?;
        let body = payload
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let draft = payload
            .get("draft")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let token = self.require_token()?;
        let info = repo_info(&root)?;
        let (owner, repo) = owner_repo(&info.remote_url).ok_or_else(|| {
            GithubError::Operation("this project's origin is not a GitHub repository".to_string())
        })?;
        let base = payload
            .get("base")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(info.default_branch);

        push_branch(&root)?;

        let input = json!({
            "owner": owner,
            "repo": repo,
            "head": info.head_branch,
            "base": base,
            "title": title,
            "body": body,
            "draft": draft,
        });
        let value = Self::run_sidecar(&token, &["create-pull-request"], Some(&input.to_string()))?;
        let pull_request = value.get("pullRequest").cloned().ok_or_else(|| {
            GithubError::Operation("sidecar returned no pull request".to_string())
        })?;
        self.record_publish(&request_id, &pull_request)?;
        Ok(json!({ "pullRequest": pull_request }))
    }

    /// Reads the stored token, or `None` when there is none.
    pub fn token(&self) -> Option<String> {
        let token = fs::read_to_string(&self.token_path).ok()?;
        let token = token.trim();
        (!token.is_empty()).then(|| token.to_string())
    }

    fn require_token(&self) -> Result<String, GithubError> {
        self.token().ok_or(GithubError::NotAuthenticated)
    }

    /// Writes the token so only the owning account can read it.
    ///
    /// The restriction is re-applied to a pre-existing file, in case an earlier
    /// version (or a migration from the desktop's copy) created it wider.
    pub fn write_token(&self, token: &str) -> Result<(), GithubError> {
        use std::io::Write;

        let mut file = perms::create_private_file(&self.token_path)
            .map_err(|error| GithubError::Operation(format!("store token: {error}")))?;
        file.write_all(token.as_bytes())
            .map_err(|error| GithubError::Operation(format!("store token: {error}")))
    }

    /// Removes the stored token. A missing file is already the desired state.
    pub fn clear_token(&self) -> Result<(), GithubError> {
        match fs::remove_file(&self.token_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(GithubError::Operation(format!("clear token: {error}"))),
        }
    }

    fn completed_publish(&self, request_id: &str) -> Result<Option<Value>, GithubError> {
        let completed = self
            .completed
            .lock()
            .map_err(|_| GithubError::LockPoisoned)?;
        Ok(completed
            .iter()
            .find(|entry| entry.request_id == request_id)
            .and_then(|entry| serde_json::to_value(&entry.pull_request).ok()))
    }

    fn record_publish(&self, request_id: &str, pull_request: &Value) -> Result<(), GithubError> {
        let Ok(parsed) = serde_json::from_value::<GitHubPullRequest>(pull_request.clone()) else {
            return Ok(());
        };
        let mut completed = self
            .completed
            .lock()
            .map_err(|_| GithubError::LockPoisoned)?;
        completed.push(CompletedPublish {
            request_id: request_id.to_string(),
            pull_request: parsed,
        });
        let overflow = completed.len().saturating_sub(COMPLETED_LIMIT);
        completed.drain(..overflow);
        Ok(())
    }

    /// Runs the sidecar with the token in its environment.
    fn run_sidecar(
        token: &str,
        args: &[&str],
        stdin_data: Option<&str>,
    ) -> Result<Value, GithubError> {
        run_oneshot(
            SIDECAR_NAME,
            SIDECAR_DEV_ENTRY,
            args,
            &[(TOKEN_ENV, token)],
            stdin_data,
        )
        .map_err(GithubError::Operation)
    }
}

fn required_str(payload: &Value, key: &str) -> Result<String, GithubError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| GithubError::InvalidRequest(format!("{key} is required")))
}

/// Reads the worktree's remote, default branch, and current branch.
fn repo_info(root: &str) -> Result<GithubRepoInfo, GithubError> {
    let request = GitRequest::GithubRepoInfo {
        root: root.to_string(),
    };
    let payload =
        serde_json::to_value(request).map_err(|error| GithubError::Operation(error.to_string()))?;
    let value = pragma_core::git::handle(payload)
        .map_err(|error| GithubError::Operation(error.to_string()))?;
    serde_json::from_value(value).map_err(|error| GithubError::Operation(error.to_string()))
}

/// Pushes the current branch to `origin`, setting upstream on first push.
fn push_branch(root: &str) -> Result<(), GithubError> {
    let request = GitRequest::GithubPushBranch {
        root: root.to_string(),
    };
    let payload =
        serde_json::to_value(request).map_err(|error| GithubError::Operation(error.to_string()))?;
    pragma_core::git::handle(payload)
        .map(|_| ())
        .map_err(|error| GithubError::Operation(format!("push failed: {error}")))
}

/// Extracts `owner/repo` from an `origin` URL, SSH or HTTPS.
///
/// Returns `None` for a remote that is not GitHub — a project on another forge,
/// or none at all, simply has no pull request rather than an error.
pub fn owner_repo(remote_url: &str) -> Option<(String, String)> {
    let trimmed = remote_url.trim().trim_end_matches('/');
    let without_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let path = if let Some(rest) = without_suffix.strip_prefix("git@") {
        // `git@github.com:owner/repo`
        rest.split_once(':')?
    } else {
        let rest = without_suffix
            .strip_prefix("https://")
            .or_else(|| without_suffix.strip_prefix("http://"))
            .or_else(|| without_suffix.strip_prefix("ssh://git@"))?;
        rest.split_once('/')?
    };
    let (host, path) = path;
    if !host.trim_start_matches("git@").ends_with("github.com") {
        return None;
    }
    let (owner, repo) = path.trim_start_matches('/').split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{owner_repo, GithubHost};

    #[test]
    fn reads_owner_and_repo_from_every_remote_form() {
        for url in [
            "git@github.com:pragma-sh/pragma.git",
            "https://github.com/pragma-sh/pragma.git",
            "https://github.com/pragma-sh/pragma",
            "ssh://git@github.com/pragma-sh/pragma.git",
            "https://github.com/pragma-sh/pragma/",
        ] {
            assert_eq!(
                owner_repo(url),
                Some(("pragma-sh".to_string(), "pragma".to_string())),
                "failed for {url}"
            );
        }
    }

    #[test]
    fn a_remote_that_is_not_github_has_no_pull_request() {
        // Not an error: a project on another forge simply has no pull request,
        // and reporting a failure would put an error banner on a working repo.
        assert_eq!(owner_repo("git@gitlab.com:group/project.git"), None);
        assert_eq!(owner_repo("https://example.com/owner/repo.git"), None);
        assert_eq!(owner_repo(""), None);
    }

    #[test]
    fn a_token_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = GithubHost::new(dir.path());
        assert!(host.token().is_none());

        host.write_token("gho_secret").expect("write");
        assert_eq!(host.token().as_deref(), Some("gho_secret"));

        host.clear_token().expect("clear");
        assert!(host.token().is_none());
        host.clear_token().expect("clearing twice is idempotent");
    }

    #[test]
    fn a_blank_token_file_reads_as_signed_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = GithubHost::new(dir.path());
        host.write_token("   ").expect("write");

        assert!(host.token().is_none(), "whitespace is not a credential");
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let host = GithubHost::new(dir.path());
        host.write_token("gho_secret").expect("write");

        let mode = std::fs::metadata(dir.path().join("github-token"))
            .expect("stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "group and others must have no access");
    }
}
