//! GitHub integration backend: OAuth Device Flow, `gh` CLI adoption, on-disk
//! token storage, and the worktree-scoped git operations the PR UI needs
//! (`origin` → `owner/repo`, fetch + ahead/behind, push, PR file diffs, remote
//! branch delete).
//!
//! Secrets and OS work live here; the frontend talks to the GitHub REST/GraphQL
//! API through the Octokit client in `src/lib/github.ts`, which pulls the token
//! via [`github_token`]. The token is stored in a `0600` plaintext file under the
//! app data dir (the same model the `gh` CLI uses) — **not** the OS keychain:
//! keychain items are scoped to the app's code signature, so unsigned/dev builds
//! re-prompt for access on every rebuild.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use pragma_constants::{
    BranchSyncStatus, FileDiff, GitHubAuthStatus, GitHubRepoRef, GitHubUser, CONSTANTS,
};
use pragma_core::git::{GitRequest, GithubRepoInfo};
use serde::de::DeserializeOwned;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

/// Settings key holding the "user skipped GitHub setup" flag (persisted in the
/// `settings` table — it isn't a secret).
const SETUP_DISMISSED_KEY: &str = "github.setupDismissed";
/// Filename (under the app data dir) holding the GitHub token.
const TOKEN_FILE_NAME: &str = "github-token";
/// User-Agent sent on every GitHub HTTP request (GitHub requires one).
const USER_AGENT: &str = "Pragma";
/// Cap on how long the device-flow poll loop runs before giving up.
const DEVICE_FLOW_TIMEOUT: Duration = Duration::from_secs(900);

// ---------------------------------------------------------------------------
// Token file storage
// ---------------------------------------------------------------------------

/// Owns the on-disk location of the GitHub token. Managed as Tauri state so every
/// command resolves the same path, derived once from the app data dir. The token
/// is a plaintext file with owner-only (`0600`) permissions — the same approach
/// the `gh` CLI takes with `~/.config/gh/hosts.yml`. The OS keychain is
/// intentionally avoided because its items are bound to the app's code signature,
/// which changes on every unsigned/dev rebuild and triggers a fresh access prompt.
#[derive(Clone)]
pub struct TokenStore {
    path: PathBuf,
}

impl TokenStore {
    /// Builds the store rooted at the app data dir.
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join(TOKEN_FILE_NAME),
        }
    }

    /// Reads the stored token, or `None` when the file is missing or empty.
    fn read(&self) -> Option<String> {
        let token = fs::read_to_string(&self.path).ok()?;
        let token = token.trim();
        if token.is_empty() {
            None
        } else {
            Some(token.to_string())
        }
    }

    /// Writes the token to disk with owner-only (`0600`) permissions.
    fn write(&self, token: &str) -> AppResult<()> {
        write_private(&self.path, token)
            .map_err(|error| AppError::GitHub(format!("failed to store token: {error}")))
    }

    /// Removes the stored token; a missing file is treated as success.
    fn clear(&self) -> AppResult<()> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::GitHub(format!("failed to clear token: {error}"))),
        }
    }
}

/// Writes `contents` to `path`, creating it with `0600` permissions so only the
/// owner can read the token. The mode is also re-applied to a pre-existing file in
/// case it was previously created more permissively.
#[cfg(unix)]
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Non-Unix fallback (we only ship macOS + Linux, but keep the build portable).
#[cfg(not(unix))]
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    fs::write(path, contents)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Builds the shared blocking HTTP client (rustls, modest timeout).
fn http_client() -> AppResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::GitHub(error.to_string()))
}

/// Fetches the authenticated user for a token via `GET /user`.
fn fetch_user(token: &str) -> AppResult<GitHubUser> {
    let url = format!(
        "{}/user",
        CONSTANTS.github.api_base_url.trim_end_matches('/')
    );
    let response = http_client()?
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|error| AppError::GitHub(error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::GitHub(format!(
            "GET /user failed: {}",
            response.status()
        )));
    }
    let body = response
        .text()
        .map_err(|error| AppError::GitHub(error.to_string()))?;
    parse_user(&body)
}

/// Parses a GitHub user JSON object into [`GitHubUser`].
fn parse_user(body: &str) -> AppResult<GitHubUser> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    let login = value["login"]
        .as_str()
        .ok_or_else(|| AppError::GitHub("user response missing login".to_string()))?
        .to_string();
    Ok(GitHubUser {
        login,
        name: value["name"].as_str().map(str::to_string),
        avatar_url: value["avatar_url"].as_str().unwrap_or_default().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

/// Reports whether a token is stored, whether the `gh` CLI is an option, the
/// signed-in user (best-effort), and whether the setup modal was skipped. Drives
/// both the setup modal gate and the Pull Request subtab's logged-out state.
#[tauri::command]
pub async fn github_auth_status(
    db: State<'_, Db>,
    tokens: State<'_, TokenStore>,
) -> AppResult<GitHubAuthStatus> {
    let setup_dismissed = db.setting(SETUP_DISMISSED_KEY)?.as_deref() == Some("true");
    let token = tokens.read();
    let status =
        tauri::async_runtime::spawn_blocking(move || auth_status_impl(token, setup_dismissed))
            .await
            .map_err(|error| AppError::GitHub(format!("auth status task failed: {error}")))?;
    Ok(status)
}

fn auth_status_impl(token: Option<String>, setup_dismissed: bool) -> GitHubAuthStatus {
    // Best-effort user fetch: a network error leaves `user` empty without
    // dropping the authenticated state, so offline launches still skip the modal.
    let user = token.as_deref().and_then(|token| fetch_user(token).ok());
    GitHubAuthStatus {
        authenticated: token.is_some(),
        gh_available: gh_is_authenticated(),
        user,
        setup_dismissed,
    }
}

/// Returns the stored token for the frontend Octokit client, or `None`.
#[tauri::command]
pub fn github_token(tokens: State<'_, TokenStore>) -> Option<String> {
    tokens.read()
}

/// Clears the stored token (sign out).
#[tauri::command]
pub fn github_sign_out(tokens: State<'_, TokenStore>) -> AppResult<()> {
    tokens.clear()
}

/// Persists the "user skipped GitHub setup" flag so the modal never returns.
#[tauri::command]
pub fn set_github_setup_dismissed(db: State<'_, Db>, dismissed: bool) -> AppResult<()> {
    db.set_setting(
        SETUP_DISMISSED_KEY,
        if dismissed { "true" } else { "false" },
    )
}

// ---------------------------------------------------------------------------
// `gh` CLI
// ---------------------------------------------------------------------------

/// True when the `gh` CLI is installed and authenticated.
fn gh_is_authenticated() -> bool {
    Command::new("gh")
        .args(["auth", "status"])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Reads the `gh` CLI's current token (`gh auth token`).
fn gh_token() -> AppResult<String> {
    let output = Command::new("gh")
        .args(["auth", "token"])
        .output()
        .map_err(|error| AppError::GitHub(format!("failed to run gh: {error}")))?;
    if !output.status.success() {
        return Err(AppError::GitHub(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(AppError::GitHub("gh auth token returned empty".to_string()));
    }
    Ok(token)
}

/// Adopts the `gh` CLI's token into the on-disk [`TokenStore`] (the `0600` token
/// file) and returns the user.
#[tauri::command]
pub async fn github_use_cli_token(tokens: State<'_, TokenStore>) -> AppResult<GitHubUser> {
    let store = (*tokens).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = gh_token()?;
        store.write(&token)?;
        fetch_user(&token)
    })
    .await
    .map_err(|error| AppError::GitHub(format!("gh token task failed: {error}")))?
}

// ---------------------------------------------------------------------------
// OAuth device flow
// ---------------------------------------------------------------------------

/// The data the UI needs to walk the user through the device flow: the code they
/// type and the page to enter it on, plus the opaque `deviceCode` they hand back
/// to [`github_poll_device_flow`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Requests a device + user code, opens the verification page in the browser,
/// and returns the codes for the UI to display and poll on.
#[tauri::command]
pub async fn github_start_device_flow() -> AppResult<DeviceFlowStart> {
    tauri::async_runtime::spawn_blocking(start_device_flow_impl)
        .await
        .map_err(|error| AppError::GitHub(format!("device flow task failed: {error}")))?
}

fn start_device_flow_impl() -> AppResult<DeviceFlowStart> {
    let response = http_client()?
        .post(CONSTANTS.github.device_code_url.as_str())
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .form(&[
            ("client_id", CONSTANTS.github.oauth_client_id.as_str()),
            ("scope", &CONSTANTS.github.scopes.join(" ")),
        ])
        .send()
        .map_err(|error| AppError::GitHub(error.to_string()))?;
    let body = response
        .text()
        .map_err(|error| AppError::GitHub(error.to_string()))?;
    let start = parse_device_code(&body)?;
    // Best-effort: launch the verification page so the user lands on the code
    // entry screen. If it fails the UI still shows the URL + code to use.
    let _ = opener::open(&start.verification_uri);
    Ok(start)
}

/// Parses the device-code response JSON.
fn parse_device_code(body: &str) -> AppResult<DeviceFlowStart> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    if let Some(error) = value["error"].as_str() {
        return Err(AppError::GitHub(format!(
            "device code request failed: {error}"
        )));
    }
    let field = |key: &str| -> AppResult<String> {
        value[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AppError::GitHub(format!("device code response missing {key}")))
    };
    Ok(DeviceFlowStart {
        device_code: field("device_code")?,
        user_code: field("user_code")?,
        verification_uri: field("verification_uri")?,
        interval: value["interval"].as_u64().unwrap_or(5),
        expires_in: value["expires_in"].as_u64().unwrap_or(900),
    })
}

/// Outcome of one device-flow token poll.
#[derive(Debug, PartialEq, Eq)]
enum PollOutcome {
    Token(String),
    Pending,
    SlowDown,
    Denied,
    Expired,
    Error(String),
}

/// Classifies a token-endpoint response during the device flow.
fn parse_token_response(body: &str) -> PollOutcome {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return PollOutcome::Error("malformed token response".to_string());
    };
    if let Some(token) = value["access_token"].as_str() {
        return PollOutcome::Token(token.to_string());
    }
    match value["error"].as_str() {
        Some("authorization_pending") => PollOutcome::Pending,
        Some("slow_down") => PollOutcome::SlowDown,
        Some("access_denied") => PollOutcome::Denied,
        Some("expired_token") => PollOutcome::Expired,
        Some(other) => PollOutcome::Error(other.to_string()),
        None => PollOutcome::Error("unexpected token response".to_string()),
    }
}

/// Polls the token endpoint until the user authorizes (or the flow fails),
/// stores the token in the on-disk [`TokenStore`] (the `0600` token file), and
/// returns the authenticated user.
#[tauri::command]
pub async fn github_poll_device_flow(
    tokens: State<'_, TokenStore>,
    device_code: String,
    interval: u64,
) -> AppResult<GitHubUser> {
    let store = (*tokens).clone();
    tauri::async_runtime::spawn_blocking(move || {
        poll_device_flow_impl(&store, &device_code, interval)
    })
    .await
    .map_err(|error| AppError::GitHub(format!("device flow poll task failed: {error}")))?
}

fn poll_device_flow_impl(
    store: &TokenStore,
    device_code: &str,
    interval: u64,
) -> AppResult<GitHubUser> {
    let client = http_client()?;
    let mut wait = Duration::from_secs(interval.max(1));
    let deadline = Instant::now() + DEVICE_FLOW_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            return Err(AppError::GitHub(
                "device authorization timed out".to_string(),
            ));
        }
        std::thread::sleep(wait);
        let response = client
            .post(CONSTANTS.github.access_token_url.as_str())
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .form(&[
                ("client_id", CONSTANTS.github.oauth_client_id.as_str()),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .map_err(|error| AppError::GitHub(error.to_string()))?;
        let body = response
            .text()
            .map_err(|error| AppError::GitHub(error.to_string()))?;
        match parse_token_response(&body) {
            PollOutcome::Token(token) => {
                store.write(&token)?;
                return fetch_user(&token);
            }
            PollOutcome::Pending => {}
            PollOutcome::SlowDown => wait += Duration::from_secs(5),
            PollOutcome::Denied => {
                return Err(AppError::GitHub("authorization was denied".to_string()))
            }
            PollOutcome::Expired => {
                return Err(AppError::GitHub("device code expired".to_string()))
            }
            PollOutcome::Error(error) => return Err(AppError::GitHub(error)),
        }
    }
}

// ---------------------------------------------------------------------------
// Worktree-scoped git operations
// ---------------------------------------------------------------------------

/// Parses `origin` into owner/repo plus the default and head branches.
#[tauri::command]
pub fn github_repo_ref(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<GitHubRepoRef> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let info: GithubRepoInfo = host_git(
        &pty,
        &GitRequest::GithubRepoInfo {
            root: worktree.path,
        },
    )?;
    let (owner, repo) = parse_remote_url(info.remote_url.trim()).ok_or_else(|| {
        AppError::GitHub(format!(
            "could not parse origin remote URL: {}",
            info.remote_url.trim()
        ))
    })?;
    // The default PR base is the branch this worktree was created to merge back
    // into — its parent worktree's branch — falling back to null for the
    // main/parentless worktree (the UI then defaults to the repo default branch).
    let parent_branch = worktree
        .parent_id
        .as_deref()
        .and_then(|parent_id| db.worktree(parent_id).ok())
        .map(|parent| parent.branch);
    Ok(GitHubRepoRef {
        owner,
        repo,
        default_branch: info.default_branch,
        head_branch: info.head_branch,
        parent_branch,
    })
}

/// The default PR title — the worktree branch's last commit subject (`git log -1
/// --pretty=%s`), used to seed the create-PR form. Empty string when there are no
/// commits yet, so the UI just shows an empty title input.
#[tauri::command]
pub fn github_default_pr_title(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<String> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    host_git(
        &pty,
        &GitRequest::GithubDefaultPrTitle {
            root: worktree.path,
        },
    )
}

/// Fetches `origin` and returns the branch's ahead/behind counts vs its
/// upstream — the create-PR pre-flight.
#[tauri::command]
pub async fn github_fetch_and_sync(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<BranchSyncStatus> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        host_git(
            &pty,
            &GitRequest::GithubFetchAndSync {
                root: worktree.path,
            },
        )
    })
    .await
    .map_err(|error| AppError::GitHub(format!("fetch task failed: {error}")))?
}

/// Pushes the worktree's branch to `origin`, setting upstream, before opening a
/// PR (`git push -u origin <branch>`).
#[tauri::command]
pub async fn github_push_branch(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<()> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        host_git(
            &pty,
            &GitRequest::GithubPushBranch {
                root: worktree.path,
            },
        )
    })
    .await
    .map_err(|error| AppError::GitHub(format!("push task failed: {error}")))?
}

/// Produces the local `base...HEAD` diff for a single PR file (review tab).
#[tauri::command]
pub fn github_pr_file_diff(
    db: State<'_, Db>,
    hosts: State<'_, crate::hosts::Hosts>,
    worktree_id: String,
    base: String,
    path: String,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let worktree = db.worktree(&worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    crate::git::pr_file_diff(&pty, &root, &base, &path, old_path.as_deref())
}

/// Deletes the worktree's branch on `origin` (post-merge cleanup).
#[tauri::command]
pub async fn github_delete_remote_branch(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<()> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        host_git(
            &pty,
            &GitRequest::GithubDeleteRemoteBranch {
                root: worktree.path,
            },
        )
    })
    .await
    .map_err(|error| AppError::GitHub(format!("delete branch task failed: {error}")))?
}

// ---------------------------------------------------------------------------
// Small git helpers (local to this module)
// ---------------------------------------------------------------------------

/// Runs a host-side git RPC and maps transport/core failures into GitHub errors
/// so the PR UI keeps a single error category.
fn host_git<T: DeserializeOwned>(pty: &PtyClient, request: &GitRequest) -> AppResult<T> {
    crate::git::host_rpc(pty, request).map_err(|error| AppError::GitHub(error.to_string()))
}

/// Parses owner/repo from an SSH or HTTPS GitHub remote URL.
fn parse_remote_url(url: &str) -> Option<(String, String)> {
    // Normalize the path portion regardless of scheme:
    //   git@github.com:owner/repo.git
    //   ssh://git@github.com/owner/repo.git
    //   https://github.com/owner/repo(.git)
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
        .unwrap_or(url);
    // Drop any `user@host` prefix, splitting on the first `/` or `:`.
    let path = without_scheme
        .split_once(['/', ':'])
        .map_or(without_scheme, |(_, rest)| rest);
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.rsplitn(2, '/');
    let repo = parts.next()?.to_string();
    let owner = parts.next()?.rsplit(['/', ':']).next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_device_code, parse_remote_url, parse_token_response, parse_user, PollOutcome,
        TokenStore,
    };

    #[test]
    fn token_store_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = TokenStore::new(dir.path());

        // Nothing stored yet.
        assert_eq!(store.read(), None);

        // Write then read back.
        store.write("gho_secret").expect("write");
        assert_eq!(store.read().as_deref(), Some("gho_secret"));

        // Owner-only permissions on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(super::TOKEN_FILE_NAME))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Clear removes it; clearing again is still Ok.
        store.clear().expect("clear");
        assert_eq!(store.read(), None);
        store.clear().expect("clear missing");
    }

    #[test]
    fn token_store_treats_blank_file_as_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = TokenStore::new(dir.path());
        store.write("   \n").expect("write");
        assert_eq!(store.read(), None);
    }

    #[test]
    fn parses_ssh_and_https_remotes() {
        assert_eq!(
            parse_remote_url("git@github.com:owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
        assert_eq!(
            parse_remote_url("https://github.com/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
        assert_eq!(
            parse_remote_url("https://github.com/owner/repo"),
            Some(("owner".to_string(), "repo".to_string()))
        );
        assert_eq!(
            parse_remote_url("ssh://git@github.com/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn rejects_unparseable_remote() {
        assert_eq!(parse_remote_url("not-a-url"), None);
    }

    #[test]
    fn parses_device_code_response() {
        let body = r#"{
            "device_code": "dc",
            "user_code": "WXYZ-1234",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }"#;
        let start = parse_device_code(body).expect("device code");
        assert_eq!(start.user_code, "WXYZ-1234");
        assert_eq!(start.device_code, "dc");
        assert_eq!(start.interval, 5);
    }

    #[test]
    fn classifies_token_poll_responses() {
        assert_eq!(
            parse_token_response(r#"{"access_token":"gho_abc","token_type":"bearer"}"#),
            PollOutcome::Token("gho_abc".to_string())
        );
        assert_eq!(
            parse_token_response(r#"{"error":"authorization_pending"}"#),
            PollOutcome::Pending
        );
        assert_eq!(
            parse_token_response(r#"{"error":"slow_down"}"#),
            PollOutcome::SlowDown
        );
        assert_eq!(
            parse_token_response(r#"{"error":"access_denied"}"#),
            PollOutcome::Denied
        );
        assert_eq!(
            parse_token_response(r#"{"error":"expired_token"}"#),
            PollOutcome::Expired
        );
    }

    #[test]
    fn parses_user_object() {
        let body = r#"{"login":"octocat","name":"The Octocat","avatar_url":"https://avatars/x"}"#;
        let user = parse_user(body).expect("user");
        assert_eq!(user.login, "octocat");
        assert_eq!(user.name.as_deref(), Some("The Octocat"));
        assert_eq!(user.avatar_url, "https://avatars/x");
    }
}
