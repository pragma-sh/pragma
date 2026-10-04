//! Host-owned account-provider state: logins (harness x provider credential
//! slots), user labels, and harness bindings, global with per-project
//! overrides.
//!
//! Everything here lives on the host that runs the harness, so an SSH or WSL
//! host keeps its own accounts. Plugin callbacks (login command, env, identify,
//! usage) run in the plugins sidecar; this module owns only the durable record,
//! the owner-only credential directories, and the pure binding rules.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pragma_constants::{
    AccountBindingScope, AccountBindingState, AccountBindings, AccountLogin, AccountsState,
    CONSTANTS,
};

use crate::{CoreError, CoreResult};

/// Current on-disk schema version of [`AccountsState`].
pub const STATE_VERSION: i64 = 1;

/// An empty state for a host that has never saved accounts.
#[must_use]
pub fn empty_state() -> AccountsState {
    AccountsState {
        version: STATE_VERSION,
        logins: Vec::new(),
        labels: std::collections::HashMap::new(),
        bindings: AccountBindingState {
            global: AccountBindings(std::collections::HashMap::new()),
            projects: std::collections::HashMap::new(),
        },
    }
}

/// The key accounts are grouped and bound by. Logins of one provider that
/// report the same identity are one account; a login that cannot identify
/// itself is its own account.
#[must_use]
pub fn account_key(login: &AccountLogin) -> String {
    match &login.identity {
        Some(identity) => format!("{}:{}", login.provider, identity.id),
        None => format!("login:{}", login.id),
    }
}

/// Id of a harness's own existing login for one account provider.
#[must_use]
pub fn default_login_id(agent_id: &str, provider_id: &str) -> String {
    format!(
        "{}:{agent_id}:{provider_id}",
        CONSTANTS.accounts.default_login_prefix
    )
}

/// The account a harness uses for `provider` in `project_root`, and where that
/// choice came from. A project override wins over the global default.
#[must_use]
pub fn effective_binding<'a>(
    state: &'a AccountsState,
    agent_id: &str,
    provider: &str,
    project_root: Option<&str>,
) -> Option<(&'a str, AccountBindingScope)> {
    let lookup = |bindings: &'a AccountBindings| {
        bindings
            .0
            .get(agent_id)
            .and_then(|providers| providers.get(provider))
            .map(String::as_str)
    };
    if let Some(key) = project_root
        .and_then(|root| state.bindings.projects.get(root))
        .and_then(lookup)
    {
        return Some((key, AccountBindingScope::Project));
    }
    lookup(&state.bindings.global).map(|key| (key, AccountBindingScope::Global))
}

/// Binds (or with `account_key: None`, unbinds) a harness's account.
///
/// A global write leaves every project override in place, so projects that
/// chose their own account keep it. A project write needs `project_root`.
pub fn set_binding(
    state: &mut AccountsState,
    agent_id: &str,
    provider: &str,
    account_key: Option<&str>,
    scope: AccountBindingScope,
    project_root: Option<&str>,
) -> CoreResult<()> {
    let bindings = match scope {
        AccountBindingScope::Global => &mut state.bindings.global,
        AccountBindingScope::Project => {
            let root = project_root.ok_or_else(|| {
                CoreError::InvalidPayload("a project binding needs projectRoot".to_string())
            })?;
            state
                .bindings
                .projects
                .entry(root.to_string())
                .or_insert_with(|| AccountBindings(std::collections::HashMap::new()))
        }
    };
    match account_key {
        Some(key) => {
            bindings
                .0
                .entry(agent_id.to_string())
                .or_default()
                .insert(provider.to_string(), key.to_string());
        }
        None => {
            if let Some(providers) = bindings.0.get_mut(agent_id) {
                providers.remove(provider);
                if providers.is_empty() {
                    bindings.0.remove(agent_id);
                }
            }
        }
    }
    state
        .bindings
        .projects
        .retain(|_, bindings| !bindings.0.is_empty());
    Ok(())
}

/// The login a harness launches with for one provider: the login of the bound
/// account that belongs to this harness, else the harness's own default login.
#[must_use]
pub fn resolve_login<'a>(
    state: &'a AccountsState,
    agent_id: &str,
    provider: &str,
    project_root: Option<&str>,
) -> Option<&'a AccountLogin> {
    let for_harness =
        |login: &&AccountLogin| login.agent_id == agent_id && login.provider == provider;
    if let Some((key, _)) = effective_binding(state, agent_id, provider, project_root) {
        if let Some(login) = state
            .logins
            .iter()
            .filter(for_harness)
            .find(|login| account_key(login) == key)
        {
            return Some(login);
        }
    }
    state
        .logins
        .iter()
        .filter(for_harness)
        .find(|login| login.home.is_none())
}

/// Replaces the login with the same id, or appends it.
pub fn upsert_login(state: &mut AccountsState, login: AccountLogin) {
    match state
        .logins
        .iter_mut()
        .find(|existing| existing.id == login.id)
    {
        Some(existing) => *existing = login,
        None => state.logins.push(login),
    }
}

/// Durable [`AccountsState`] plus the owner-only credential directory root.
pub struct AccountsStore {
    path: PathBuf,
    home_root: PathBuf,
    state: Mutex<AccountsState>,
}

impl AccountsStore {
    /// Opens the store under `pragma_dir` (the host's `~/.pragma`). A missing or
    /// corrupt file starts empty; the next write replaces it.
    #[must_use]
    pub fn open(pragma_dir: &Path) -> Self {
        let path = pragma_dir.join(CONSTANTS.accounts.state_file.as_str());
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<AccountsState>(&contents).ok())
            .unwrap_or_else(empty_state);
        Self {
            path,
            home_root: pragma_dir.join(CONSTANTS.accounts.home_dir.as_str()),
            state: Mutex::new(state),
        }
    }

    /// Opens the store for the current user's `~/.pragma`.
    pub fn for_current_user() -> CoreResult<Self> {
        let home = pragma_platform::path::home_dir()
            .ok_or_else(|| CoreError::Operation("home directory is unknown".to_string()))?;
        Ok(Self::open(&home.join(".pragma")))
    }

    /// A copy of the current state.
    pub fn snapshot(&self) -> CoreResult<AccountsState> {
        Ok(self.lock()?.clone())
    }

    /// Mutates the state and persists it before returning, so a crash never
    /// loses an acknowledged change.
    pub fn update<T>(
        &self,
        mutate: impl FnOnce(&mut AccountsState) -> CoreResult<T>,
    ) -> CoreResult<T> {
        let mut state = self.lock()?;
        let mut next = state.clone();
        let value = mutate(&mut next)?;
        self.persist(&next)?;
        *state = next;
        Ok(value)
    }

    /// Creates the owner-only credential directory for a new login.
    pub fn create_login_home(&self, provider: &str, login_id: &str) -> CoreResult<PathBuf> {
        if !is_safe_segment(provider) || !is_safe_segment(login_id) {
            return Err(CoreError::InvalidPayload(format!(
                "invalid account path segment: {provider}/{login_id}"
            )));
        }
        let provider_dir = self.home_root.join(provider);
        for dir in [&self.home_root, &provider_dir] {
            if !dir.exists() {
                pragma_platform::perms::create_private_dir(dir)?;
            }
        }
        let home = provider_dir.join(login_id);
        pragma_platform::perms::create_private_dir(&home)?;
        Ok(home)
    }

    /// Deletes a Pragma-owned credential directory. Refuses anything outside the
    /// accounts root, so a hand-edited state file can never aim this elsewhere.
    pub fn remove_login_home(&self, home: &Path) -> CoreResult<()> {
        let inside = home
            .strip_prefix(&self.home_root)
            .is_ok_and(|relative| relative.components().count() == 2);
        if !inside {
            return Err(CoreError::InvalidPayload(format!(
                "refusing to delete {} outside the accounts directory",
                home.display()
            )));
        }
        match std::fs::remove_dir_all(home) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    fn lock(&self) -> CoreResult<std::sync::MutexGuard<'_, AccountsState>> {
        self.state
            .lock()
            .map_err(|_| CoreError::Operation("accounts lock poisoned".to_string()))
    }

    /// Writes owner-only and atomically: a temporary file beside the target,
    /// flushed, then renamed over it.
    fn persist(&self, state: &AccountsState) -> CoreResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = self.path.with_extension("json.tmp");
        let contents = serde_json::to_vec_pretty(state)
            .map_err(|error| CoreError::Operation(format!("serialize accounts: {error}")))?;
        let mut file = pragma_platform::perms::create_private_file(&temporary)?;
        file.write_all(&contents)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

/// True for one plain path segment (no separators, no `.`/`..`).
fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pragma_constants::AccountIdentity;

    fn login(id: &str, agent: &str, identity: Option<&str>, home: Option<&str>) -> AccountLogin {
        AccountLogin {
            id: id.to_string(),
            plugin_id: "pragma.claude-code".to_string(),
            provider_id: "anthropic".to_string(),
            provider: "anthropic".to_string(),
            agent_id: agent.to_string(),
            home: home.map(str::to_string),
            credential_path: None,
            identity: identity.map(|id| AccountIdentity {
                id: id.to_string(),
                email: None,
                name: None,
                plan: None,
            }),
            created_at: 0,
            updated_at: 0,
            token_group: None,
        }
    }

    #[test]
    fn account_key_groups_by_identity_and_falls_back_to_login() {
        assert_eq!(
            account_key(&login("a", "cc", Some("org"), None)),
            "anthropic:org"
        );
        assert_eq!(account_key(&login("a", "cc", None, None)), "login:a");
    }

    #[test]
    fn project_override_wins_and_survives_a_global_write() {
        let mut state = empty_state();
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("anthropic:work"),
            AccountBindingScope::Project,
            Some("/p"),
        )
        .expect("project binding");
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("anthropic:home"),
            AccountBindingScope::Global,
            None,
        )
        .expect("global binding");
        assert_eq!(
            effective_binding(&state, "cc", "anthropic", Some("/p")),
            Some(("anthropic:work", AccountBindingScope::Project))
        );
        assert_eq!(
            effective_binding(&state, "cc", "anthropic", Some("/other")),
            Some(("anthropic:home", AccountBindingScope::Global))
        );
    }

    #[test]
    fn clearing_the_last_project_binding_drops_the_project() {
        let mut state = empty_state();
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("k"),
            AccountBindingScope::Project,
            Some("/p"),
        )
        .expect("bind");
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            None,
            AccountBindingScope::Project,
            Some("/p"),
        )
        .expect("unbind");
        assert!(state.bindings.projects.is_empty());
    }

    #[test]
    fn project_binding_requires_a_root() {
        let mut state = empty_state();
        assert!(set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("k"),
            AccountBindingScope::Project,
            None
        )
        .is_err());
    }

    #[test]
    fn resolve_login_prefers_the_harness_login_of_the_bound_account() {
        let mut state = empty_state();
        state
            .logins
            .push(login("default", "cc", Some("home"), None));
        state
            .logins
            .push(login("w1", "cc", Some("work"), Some("/h/w1")));
        state
            .logins
            .push(login("w2", "opencode", Some("work"), Some("/h/w2")));
        assert_eq!(
            resolve_login(&state, "cc", "anthropic", None).map(|l| l.id.as_str()),
            Some("default")
        );
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("anthropic:work"),
            AccountBindingScope::Global,
            None,
        )
        .expect("bind");
        assert_eq!(
            resolve_login(&state, "cc", "anthropic", None).map(|l| l.id.as_str()),
            Some("w1")
        );
    }

    #[test]
    fn resolve_login_falls_back_to_default_when_the_bound_account_has_no_harness_login() {
        let mut state = empty_state();
        state
            .logins
            .push(login("default", "cc", Some("home"), None));
        set_binding(
            &mut state,
            "cc",
            "anthropic",
            Some("anthropic:other"),
            AccountBindingScope::Global,
            None,
        )
        .expect("bind");
        assert_eq!(
            resolve_login(&state, "cc", "anthropic", None).map(|l| l.id.as_str()),
            Some("default")
        );
    }

    #[test]
    fn store_persists_and_reloads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AccountsStore::open(dir.path());
        store
            .update(|state| {
                upsert_login(state, login("a", "cc", Some("org"), None));
                Ok(())
            })
            .expect("update");
        let reopened = AccountsStore::open(dir.path());
        assert_eq!(reopened.snapshot().expect("snapshot").logins.len(), 1);
    }

    #[test]
    fn login_homes_stay_inside_the_accounts_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AccountsStore::open(dir.path());
        let home = store.create_login_home("anthropic", "abc").expect("home");
        assert!(home.is_dir());
        assert!(store.create_login_home("../x", "abc").is_err());
        assert!(store.remove_login_home(dir.path()).is_err());
        store.remove_login_home(&home).expect("remove");
        assert!(!home.exists());
    }
}
