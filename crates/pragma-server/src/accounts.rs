//! `accounts` RPC domain: host-owned account providers.
//!
//! The durable record and the binding rules live in `pragma_core::accounts`;
//! plugin callbacks (login command, env, identify, usage) run in the plugins
//! sidecar. This module glues the two together, runs each sign-in in a hidden
//! PTY session on this host, and hands every launch path — desktop, agent
//! board, CLI, fanouts, mobile — the same env for the account a harness is
//! bound to.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pragma_constants::{
    AccountBindingScope, AccountEffectiveBinding, AccountLogin, AccountLoginSession,
    AccountProviderInfo, AccountSessionUse, AccountUsageEntry, AccountsListResult, AccountsState,
    CONSTANTS,
};
use pragma_core::accounts::{self as core_accounts, AccountsStore};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::registry::Registry;

const LOGIN_SESSION_PREFIX: &str = "account-login-";
const LOGIN_COLS: u16 = 200;
const LOGIN_ROWS: u16 = 40;

/// One `accounts` RPC request.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AccountsRequest {
    /// Providers, logins, bindings, and live session accounts. Cheap: no
    /// plugin callbacks beyond listing providers.
    List {
        project_root: Option<String>,
    },
    /// Like `list`, after re-running every login's `identify`.
    Refresh {
        project_root: Option<String>,
    },
    /// Usage limits, loaded once per account through one of its logins.
    Usage {
        project_root: Option<String>,
        account_keys: Option<Vec<String>>,
    },
    BeginLogin {
        plugin_id: String,
        provider_id: String,
        agent_id: String,
        project_root: Option<String>,
    },
    LoginStatus {
        login_id: String,
    },
    LoginInput {
        login_id: String,
        data: String,
    },
    CompleteLogin {
        login_id: String,
        project_root: Option<String>,
    },
    CancelLogin {
        login_id: String,
    },
    SetBinding {
        agent_id: String,
        provider: String,
        account_key: Option<String>,
        scope: AccountBindingScope,
        project_root: Option<String>,
    },
    SetLabel {
        account_key: String,
        label: Option<String>,
    },
    RemoveLogin {
        login_id: String,
    },
    /// Env a launch of `agent_id` needs for its bound accounts. With `tab_id`,
    /// the accounts are recorded against that session.
    LaunchEnv {
        agent_id: String,
        project_root: Option<String>,
        tab_id: Option<String>,
    },
}

/// A sign-in that is still running in its hidden terminal.
struct PendingLogin {
    session_id: String,
    provider: AccountProviderInfo,
    agent_id: String,
    home: Option<String>,
    credential_path: Option<String>,
    instructions: Option<String>,
    started_at: Instant,
}

/// Host account state plus in-flight sign-ins and per-session account records.
pub struct AccountsHost {
    store: Option<AccountsStore>,
    logins: Mutex<HashMap<String, PendingLogin>>,
    sessions: Mutex<HashMap<String, Vec<AccountSessionUse>>>,
}

impl AccountsHost {
    /// Opens the current user's store. A host without a home directory still
    /// serves launches; it just has no accounts.
    pub fn new() -> Self {
        let store = AccountsStore::for_current_user()
            .map_err(|error| eprintln!("accounts store unavailable: {error}"))
            .ok();
        Self {
            store,
            logins: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Handles one `accounts` RPC payload.
    pub fn handle(&self, registry: &Registry, payload: Value) -> Result<Value, String> {
        let request: AccountsRequest = serde_json::from_value(payload)
            .map_err(|error| format!("invalid accounts request: {error}"))?;
        match request {
            AccountsRequest::List { project_root } => {
                to_value(&self.list(registry, project_root.as_deref(), false)?)
            }
            AccountsRequest::Refresh { project_root } => {
                to_value(&self.list(registry, project_root.as_deref(), true)?)
            }
            AccountsRequest::Usage {
                project_root,
                account_keys,
            } => {
                to_value(&self.usage(registry, project_root.as_deref(), account_keys.as_deref())?)
            }
            AccountsRequest::BeginLogin {
                plugin_id,
                provider_id,
                agent_id,
                project_root,
            } => self.begin_login(
                registry,
                &plugin_id,
                &provider_id,
                &agent_id,
                project_root.as_deref(),
            ),
            AccountsRequest::LoginStatus { login_id } => {
                to_value(&self.login_status(registry, &login_id)?)
            }
            AccountsRequest::LoginInput { login_id, data } => {
                let session_id = self.pending_session(&login_id)?;
                registry
                    .write(&session_id, &data)
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "ok": true }))
            }
            AccountsRequest::CompleteLogin {
                login_id,
                project_root,
            } => to_value(&self.complete_login(registry, &login_id, project_root.as_deref())?),
            AccountsRequest::CancelLogin { login_id } => {
                self.cancel_login(registry, &login_id)?;
                Ok(json!({ "ok": true }))
            }
            AccountsRequest::SetBinding {
                agent_id,
                provider,
                account_key,
                scope,
                project_root,
            } => {
                self.set_binding(
                    registry,
                    &agent_id,
                    &provider,
                    account_key.as_deref(),
                    scope,
                    project_root.as_deref(),
                )?;
                Ok(json!({ "ok": true }))
            }
            AccountsRequest::SetLabel { account_key, label } => {
                self.store()?
                    .update(|state| {
                        match label
                            .map(|label| label.trim().to_string())
                            .filter(|l| !l.is_empty())
                        {
                            Some(label) => state.labels.insert(account_key.clone(), label),
                            None => state.labels.remove(&account_key),
                        };
                        Ok(())
                    })
                    .map_err(|error| error.to_string())?;
                Ok(json!({ "ok": true }))
            }
            AccountsRequest::RemoveLogin { login_id } => {
                self.remove_login(&login_id)?;
                Ok(json!({ "ok": true }))
            }
            AccountsRequest::LaunchEnv {
                agent_id,
                project_root,
                tab_id,
            } => {
                let env = self.launch_env(
                    registry,
                    &agent_id,
                    project_root.as_deref(),
                    tab_id.as_deref(),
                );
                Ok(json!({ "env": env }))
            }
        }
    }

    /// Env for launching `agent_id` with its bound accounts in `project_root`.
    ///
    /// Never fails a launch: a sidecar or store problem logs and yields the
    /// harness's own default login (an empty env).
    pub fn launch_env(
        &self,
        registry: &Registry,
        agent_id: &str,
        project_root: Option<&str>,
        tab_id: Option<&str>,
    ) -> Vec<(String, String)> {
        match self.try_launch_env(registry, agent_id, project_root, tab_id) {
            Ok(env) => env,
            Err(error) => {
                eprintln!("accounts: launch env for {agent_id} unavailable: {error}");
                Vec::new()
            }
        }
    }

    fn try_launch_env(
        &self,
        registry: &Registry,
        agent_id: &str,
        project_root: Option<&str>,
        tab_id: Option<&str>,
    ) -> Result<Vec<(String, String)>, String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(Vec::new());
        };
        let state = store.snapshot().map_err(|error| error.to_string())?;
        let providers = providers_for(registry, project_root)?;
        let mut env: Vec<(String, String)> = Vec::new();
        let mut uses = Vec::new();
        let mut swaps = Vec::new();
        let mut resolved_groups: Vec<String> = Vec::new();
        for provider in providers
            .iter()
            .filter(|provider| provider.agent_ids.iter().any(|id| id == agent_id))
        {
            let Some(login) =
                core_accounts::resolve_login(&state, agent_id, &provider.provider, project_root)
            else {
                continue;
            };
            if let Some(group) = login.token_group.clone() {
                resolved_groups.push(group);
            }
            uses.push(AccountSessionUse {
                tab_id: tab_id.unwrap_or_default().to_string(),
                agent_id: agent_id.to_string(),
                provider: provider.provider.clone(),
                account_key: core_accounts::account_key(login),
            });
            // A swap provider writes the shared file the harness reads, so it
            // runs once the env (which may move that file) is complete — and
            // for the harness's own login too, to swap it back in.
            if provider.swaps {
                swaps.push((provider, login.home.as_deref()));
                continue;
            }
            if login.home.is_none() || !provider.multi_account {
                continue;
            }
            let launch = launch_op(registry, provider, login.home.as_deref(), project_root)?;
            for (key, value) in launch.env {
                // Two providers of one harness that set the same variable
                // cannot both win; the first declared provider keeps it.
                if !env.iter().any(|(existing, _)| *existing == key) {
                    env.push((key, value));
                }
            }
        }
        for group in resolved_groups {
            self.sync_token_group(registry, &providers, &group, project_root);
        }
        for (provider, home) in swaps {
            // A failed swap leaves the shared file as it was; the launch still
            // goes ahead rather than blocking the user's agent.
            if let Err(error) = activate_op(registry, provider, home, &env, project_root) {
                eprintln!(
                    "accounts: switching {agent_id} to its {} account failed: {error}",
                    provider.title
                );
            }
        }
        if let Some(tab_id) = tab_id.filter(|id| !id.is_empty()) {
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.insert(tab_id.to_string(), uses);
            }
        }
        Ok(env)
    }

    fn list(
        &self,
        registry: &Registry,
        project_root: Option<&str>,
        identify: bool,
    ) -> Result<AccountsListResult, String> {
        let providers = providers_for(registry, project_root)?;
        let store = self.store()?;
        store
            .update(|state| {
                ensure_default_logins(state, &providers);
                Ok(())
            })
            .map_err(|error| error.to_string())?;
        if identify {
            self.sync_token_groups(registry, &providers, project_root);
            self.identify_all(registry, &providers, project_root)?;
        }
        let state = store.snapshot().map_err(|error| error.to_string())?;
        let effective = effective_bindings(&state, &providers, project_root);
        let login_keys = state
            .logins
            .iter()
            .map(|login| (login.id.clone(), core_accounts::account_key(login)))
            .collect();
        Ok(AccountsListResult {
            providers,
            state,
            login_keys,
            effective,
            sessions: self.live_sessions(registry),
        })
    }

    /// Re-runs `identify` for every login, concurrently, and saves the results.
    fn identify_all(
        &self,
        registry: &Registry,
        providers: &[AccountProviderInfo],
        project_root: Option<&str>,
    ) -> Result<(), String> {
        let store = self.store()?;
        let logins = store.snapshot().map_err(|error| error.to_string())?.logins;
        let identified: Vec<(String, Option<String>, Result<Value, String>)> =
            thread::scope(|scope| {
                let handles: Vec<_> = logins
                    .iter()
                    .filter_map(|login| {
                        let provider = provider_for_login(providers, login)?;
                        Some(scope.spawn(move || {
                            let credential_path =
                                launch_op(registry, provider, login.home.as_deref(), project_root)
                                    .ok()
                                    .and_then(|launch| launch.credential_path);
                            let identity = identify_op(
                                registry,
                                provider,
                                login.home.as_deref(),
                                project_root,
                            );
                            (login.id.clone(), credential_path, identity)
                        }))
                    })
                    .collect();
                handles
                    .into_iter()
                    .filter_map(|handle| handle.join().ok())
                    .collect()
            });
        store
            .update(|state| {
                let now = now_ms();
                for (id, credential_path, identity) in identified {
                    let Some(login) = state.logins.iter_mut().find(|login| login.id == id) else {
                        continue;
                    };
                    match identity {
                        Ok(value) => {
                            login.identity = serde_json::from_value(value).ok();
                            login.updated_at = now;
                        }
                        Err(error) => eprintln!("accounts: identify {id} failed: {error}"),
                    }
                    if credential_path.is_some() {
                        login.credential_path = credential_path;
                    }
                }
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    fn usage(
        &self,
        registry: &Registry,
        project_root: Option<&str>,
        account_keys: Option<&[String]>,
    ) -> Result<Vec<AccountUsageEntry>, String> {
        let providers = providers_for(registry, project_root)?;
        let state = self
            .store()?
            .snapshot()
            .map_err(|error| error.to_string())?;
        let targets = usage_targets(&state, &providers, account_keys);
        let entries = thread::scope(|scope| {
            let handles: Vec<_> = targets
                .into_iter()
                .map(|(key, login, provider)| {
                    scope.spawn(move || {
                        let result = registry_usage(registry, provider, login.home.as_deref(), project_root)
                            .unwrap_or_else(|error| {
                                json!({ "status": "unavailable", "reason": "error", "message": error })
                            });
                        AccountUsageEntry {
                            account_key: key,
                            login_id: login.id.clone(),
                            result: result.as_object().cloned().unwrap_or_default(),
                        }
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect()
        });
        Ok(entries)
    }

    fn begin_login(
        &self,
        registry: &Registry,
        plugin_id: &str,
        provider_id: &str,
        agent_id: &str,
        project_root: Option<&str>,
    ) -> Result<Value, String> {
        let provider = providers_for(registry, project_root)?
            .into_iter()
            .find(|provider| provider.plugin_id == plugin_id && provider.provider_id == provider_id)
            .ok_or_else(|| format!("account provider not found: {plugin_id}/{provider_id}"))?;
        if !provider.agent_ids.iter().any(|id| id == agent_id) {
            return Err(format!("{agent_id} does not use {}", provider.title));
        }
        let store = self.store()?;
        // Without an env hook the harness has exactly one login, so signing in
        // again re-signs that default login in place.
        let (login_id, home) = if provider.multi_account {
            let login_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
            let home = store
                .create_login_home(&safe_segment(&provider.provider), &login_id)
                .map_err(|error| error.to_string())?;
            (login_id, Some(home.to_string_lossy().into_owned()))
        } else {
            (core_accounts::default_login_id(agent_id, provider_id), None)
        };
        let launch = match launch_op(registry, &provider, home.as_deref(), project_root) {
            Ok(launch) => launch,
            Err(error) => {
                self.discard_home(home.as_deref());
                return Err(error);
            }
        };
        let Some(command) = launch.login_command.filter(|command| !command.is_empty()) else {
            self.discard_home(home.as_deref());
            return Err(format!("{} has no login command", provider.title));
        };
        let session_id = format!("{LOGIN_SESSION_PREFIX}{login_id}");
        let cwd = project_root
            .map(str::to_string)
            .or_else(|| {
                pragma_platform::path::home_dir().map(|home| home.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| ".".to_string());
        let env: Vec<(String, String)> = launch.env.into_iter().collect();
        // A swap provider signs in in place: swap the new, still empty login
        // into the shared credential file first, so the sign-in it replaces is
        // saved and the new one lands where the next swap will find it.
        if provider.swaps {
            if let Err(error) =
                activate_op(registry, &provider, home.as_deref(), &env, project_root)
            {
                self.discard_home(home.as_deref());
                return Err(format!("could not prepare the sign-in: {error}"));
            }
        }
        if let Err(error) = registry.spawn_with_env(
            session_id.clone(),
            String::new(),
            cwd,
            LOGIN_COLS,
            LOGIN_ROWS,
            None,
            &env,
        ) {
            self.discard_home(home.as_deref());
            return Err(error.to_string());
        }
        // `; exit` works in POSIX shells and PowerShell alike, so the session
        // ends when the login command does and the client can see it finish.
        let line = format!(
            "{}; exit\r",
            crate::registry::agent_command_line(&command, None)
        );
        // Same readiness wait as an agent launch: the shell needs a moment
        // before typed input lands at its prompt.
        thread::sleep(Duration::from_millis(CONSTANTS.agents.start_delay_ms));
        if let Err(error) = registry.write(&session_id, &line) {
            let _ = registry.kill(&session_id);
            self.discard_home(home.as_deref());
            return Err(format!("failed to start the login command: {error}"));
        }
        type_login_input(
            registry,
            &session_id,
            launch.login_input,
            launch.login_input_delay_ms,
        );
        let instructions = launch.instructions.or(provider.login_instructions.clone());
        self.logins
            .lock()
            .map_err(|_| "accounts lock poisoned".to_string())?
            .insert(
                login_id.clone(),
                PendingLogin {
                    session_id,
                    provider,
                    agent_id: agent_id.to_string(),
                    home,
                    credential_path: launch.credential_path,
                    instructions: instructions.clone(),
                    started_at: Instant::now(),
                },
            );
        Ok(json!({ "loginId": login_id, "instructions": instructions }))
    }

    fn login_status(
        &self,
        registry: &Registry,
        login_id: &str,
    ) -> Result<AccountLoginSession, String> {
        let (session_id, instructions, expired) = {
            let logins = self
                .logins
                .lock()
                .map_err(|_| "accounts lock poisoned".to_string())?;
            let pending = logins
                .get(login_id)
                .ok_or_else(|| format!("no sign-in in progress: {login_id}"))?;
            (
                pending.session_id.clone(),
                pending.instructions.clone(),
                pending.started_at.elapsed()
                    > Duration::from_millis(
                        u64::try_from(CONSTANTS.accounts.login_timeout_ms).unwrap_or(u64::MAX),
                    ),
            )
        };
        if expired {
            self.cancel_login(registry, login_id)?;
            return Err("sign-in timed out".to_string());
        }
        let (bytes, exited) = registry
            .session_scrollback(&session_id)
            .unwrap_or((Vec::new(), true));
        let (text, urls) = terminal_text(&bytes);
        let max = usize::try_from(CONSTANTS.accounts.login_output_max_bytes).unwrap_or(usize::MAX);
        Ok(AccountLoginSession {
            login_id: login_id.to_string(),
            instructions,
            urls,
            output: tail(&text, max),
            exited,
        })
    }

    fn complete_login(
        &self,
        registry: &Registry,
        login_id: &str,
        project_root: Option<&str>,
    ) -> Result<AccountLogin, String> {
        let (provider, home, agent_id, credential_path, session_id) = {
            let logins = self
                .logins
                .lock()
                .map_err(|_| "accounts lock poisoned".to_string())?;
            let pending = logins
                .get(login_id)
                .ok_or_else(|| format!("no sign-in in progress: {login_id}"))?;
            (
                pending.provider.clone(),
                pending.home.clone(),
                pending.agent_id.clone(),
                pending.credential_path.clone(),
                pending.session_id.clone(),
            )
        };
        let identity = identify_op(registry, &provider, home.as_deref(), project_root)?;
        let identity: Option<pragma_constants::AccountIdentity> = serde_json::from_value(identity)
            .map_err(|error| format!("invalid identity: {error}"))?;
        if identity.is_none() && provider.multi_account {
            return Err(format!("Not signed in to {} yet.", provider.title));
        }
        let now = now_ms();
        let store = self.store()?;
        let login = store
            .update(|state| {
                let created_at = state
                    .logins
                    .iter()
                    .find(|login| login.id == login_id)
                    .map_or(now, |login| login.created_at);
                let login = AccountLogin {
                    id: login_id.to_string(),
                    plugin_id: provider.plugin_id.clone(),
                    provider_id: provider.provider_id.clone(),
                    provider: provider.provider.clone(),
                    agent_id: agent_id.clone(),
                    home: home.clone(),
                    credential_path: credential_path.clone(),
                    identity: identity.clone(),
                    created_at,
                    updated_at: now,
                    token_group: None,
                };
                core_accounts::upsert_login(state, login.clone());
                Ok(login)
            })
            .map_err(|error| error.to_string())?;
        let _ = registry.kill(&session_id);
        if let Ok(mut logins) = self.logins.lock() {
            logins.remove(login_id);
        }
        Ok(login)
    }

    fn cancel_login(&self, registry: &Registry, login_id: &str) -> Result<(), String> {
        let pending = self
            .logins
            .lock()
            .map_err(|_| "accounts lock poisoned".to_string())?
            .remove(login_id);
        if let Some(pending) = pending {
            let _ = registry.kill(&pending.session_id);
            self.discard_home(pending.home.as_deref());
            if pending.provider.swaps {
                self.restore_swap(registry, &pending);
            }
        }
        Ok(())
    }

    /// Swaps the harness's globally bound account back into its shared
    /// credential file after an abandoned sign-in, which left it signed out of
    /// the provider. A project override is restored by that project's next launch.
    fn restore_swap(&self, registry: &Registry, pending: &PendingLogin) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let Ok(state) = store.snapshot() else {
            return;
        };
        let home = core_accounts::resolve_login(
            &state,
            &pending.agent_id,
            &pending.provider.provider,
            None,
        )
        .and_then(|login| login.home.clone());
        if let Err(error) = activate_op(registry, &pending.provider, home.as_deref(), &[], None) {
            eprintln!(
                "accounts: restoring {}'s {} sign-in failed: {error}",
                pending.agent_id, pending.provider.title
            );
        }
    }

    /// Binds a harness to an account, first giving it a login for that
    /// account when it can share another harness's sign-in.
    fn set_binding(
        &self,
        registry: &Registry,
        agent_id: &str,
        provider: &str,
        account_key: Option<&str>,
        scope: AccountBindingScope,
        project_root: Option<&str>,
    ) -> Result<(), String> {
        if let Some(key) = account_key {
            self.adopt_shared_login(registry, agent_id, provider, key, project_root)?;
        }
        self.store()?
            .update(|state| {
                core_accounts::set_binding(
                    state,
                    agent_id,
                    provider,
                    account_key,
                    scope,
                    project_root,
                )
            })
            .map_err(|error| error.to_string())
    }

    /// Gives `agent_id` a login of its own for account `key` by copying
    /// another harness's sign-in to it, when the harness has none and both
    /// share a token kind (see `AccountProviderInfo::shared_token_kind`). The
    /// copy and its source join one token group, which every sync keeps on
    /// the newest token.
    fn adopt_shared_login(
        &self,
        registry: &Registry,
        agent_id: &str,
        provider: &str,
        key: &str,
        project_root: Option<&str>,
    ) -> Result<(), String> {
        let providers = providers_for(registry, project_root)?;
        let Some((target, kind)) = providers.iter().find_map(|info| {
            let kind = info.shared_token_kind.as_deref()?;
            (info.shared_token_writable
                && info.provider == provider
                && info.agent_ids.iter().any(|id| id == agent_id))
            .then_some((info, kind))
        }) else {
            return Ok(());
        };
        let store = self.store()?;
        let state = store.snapshot().map_err(|error| error.to_string())?;
        let in_account = |login: &&AccountLogin| {
            login.provider == provider && core_accounts::account_key(login) == key
        };
        if state
            .logins
            .iter()
            .filter(in_account)
            .any(|login| login.agent_id == agent_id)
        {
            return Ok(());
        }
        let sources: Vec<(&AccountLogin, &AccountProviderInfo)> = state
            .logins
            .iter()
            .filter(in_account)
            .filter_map(|login| {
                let info = provider_for_login(&providers, login)?;
                (info.shared_token_kind.as_deref() == Some(kind)).then_some((login, info))
            })
            .collect();
        let Some((source, token)) = freshest_token(registry, &sources, project_root) else {
            return Err(format!(
                "No harness has a sign-in to this account that {} can use. Sign in with {} instead.",
                target.title, target.title
            ));
        };
        let login_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let home = store
            .create_login_home(&safe_segment(provider), &login_id)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let identity = write_token_op(registry, target, Some(&home), &token, project_root)
            .and_then(|()| identify_op(registry, target, Some(&home), project_root))
            .and_then(|value| {
                serde_json::from_value::<Option<pragma_constants::AccountIdentity>>(value)
                    .map_err(|error| format!("invalid identity: {error}"))
            });
        let identity = match identity {
            Ok(Some(identity)) => identity,
            Ok(None) => {
                self.discard_home(Some(&home));
                return Err(format!(
                    "{} could not read the shared sign-in.",
                    target.title
                ));
            }
            Err(error) => {
                self.discard_home(Some(&home));
                return Err(error);
            }
        };
        let group = source
            .token_group
            .clone()
            .unwrap_or_else(|| source.id.clone());
        let source_id = source.id.clone();
        let credential_path = launch_op(registry, target, Some(&home), project_root)
            .ok()
            .and_then(|launch| launch.credential_path);
        let now = now_ms();
        store
            .update(|state| {
                if let Some(source) = state.logins.iter_mut().find(|login| login.id == source_id) {
                    source.token_group = Some(group.clone());
                }
                core_accounts::upsert_login(
                    state,
                    AccountLogin {
                        id: login_id.clone(),
                        plugin_id: target.plugin_id.clone(),
                        provider_id: target.provider_id.clone(),
                        provider: target.provider.clone(),
                        agent_id: agent_id.to_string(),
                        home: Some(home.clone()),
                        credential_path: credential_path.clone(),
                        identity: Some(identity.clone()),
                        created_at: now,
                        updated_at: now,
                        token_group: Some(group.clone()),
                    },
                );
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    /// Brings every login of every token group onto its group's newest token.
    pub fn sync_all_token_groups(&self, registry: &Registry) {
        let Ok(providers) = providers_for(registry, None) else {
            return;
        };
        self.sync_token_groups(registry, &providers, None);
    }

    fn sync_token_groups(
        &self,
        registry: &Registry,
        providers: &[AccountProviderInfo],
        project_root: Option<&str>,
    ) {
        let Some(Ok(state)) = self.store.as_ref().map(AccountsStore::snapshot) else {
            return;
        };
        let mut groups: Vec<String> = state
            .logins
            .iter()
            .filter_map(|login| login.token_group.clone())
            .collect();
        groups.sort();
        groups.dedup();
        for group in groups {
            self.sync_token_group(registry, providers, &group, project_root);
        }
    }

    /// Reads every login in `group` and writes the newest token (the one that
    /// expires last) to each login that holds an older one. A harness that
    /// refreshed its token, which rotates the refresh token, thereby passes it
    /// on before another copy tries the used one.
    fn sync_token_group(
        &self,
        registry: &Registry,
        providers: &[AccountProviderInfo],
        group: &str,
        project_root: Option<&str>,
    ) {
        let Some(Ok(state)) = self.store.as_ref().map(AccountsStore::snapshot) else {
            return;
        };
        let members: Vec<(&AccountLogin, &AccountProviderInfo)> = state
            .logins
            .iter()
            .filter(|login| login.token_group.as_deref() == Some(group))
            .filter_map(|login| Some((login, provider_for_login(providers, login)?)))
            .filter(|(_, info)| info.shared_token_kind.is_some())
            .collect();
        if members.len() < 2 {
            return;
        }
        let tokens: Vec<(&AccountLogin, &AccountProviderInfo, Option<Value>)> = members
            .iter()
            .map(|(login, info)| {
                let token = read_token_op(registry, info, login.home.as_deref(), project_root)
                    .unwrap_or_else(|error| {
                        eprintln!("accounts: reading {}'s sign-in failed: {error}", login.id);
                        None
                    });
                (*login, *info, token)
            })
            .collect();
        // Only OAuth sign-ins rotate. An API key never changes, so a copy is
        // left alone (overwriting it could undo a key the user just replaced).
        let Some(newest) = tokens
            .iter()
            .filter_map(|(_, _, token)| token.as_ref())
            .filter(|token| is_oauth(token))
            .max_by_key(|token| token_expires(token))
            .cloned()
        else {
            return;
        };
        for (login, info, token) in &tokens {
            if !info.shared_token_writable
                || token
                    .as_ref()
                    .is_some_and(|token| token.get("access") == newest.get("access"))
            {
                continue;
            }
            if let Err(error) =
                write_token_op(registry, info, login.home.as_deref(), &newest, project_root)
            {
                eprintln!("accounts: syncing {}'s sign-in failed: {error}", login.id);
            }
        }
    }

    fn remove_login(&self, login_id: &str) -> Result<(), String> {
        let store = self.store()?;
        let removed = store
            .update(|state| {
                let index = state
                    .logins
                    .iter()
                    .position(|login| login.id == login_id)
                    .ok_or_else(|| pragma_core::CoreError::NotFound(login_id.to_string()))?;
                if state.logins[index].home.is_none() {
                    return Err(pragma_core::CoreError::InvalidPayload(
                        "a harness's own login is managed by the harness".to_string(),
                    ));
                }
                Ok(state.logins.remove(index))
            })
            .map_err(|error| error.to_string())?;
        self.discard_home(removed.home.as_deref());
        Ok(())
    }

    fn discard_home(&self, home: Option<&str>) {
        if let (Some(store), Some(home)) = (self.store.as_ref(), home) {
            if let Err(error) = store.remove_login_home(std::path::Path::new(home)) {
                eprintln!("accounts: failed to remove {home}: {error}");
            }
        }
    }

    fn pending_session(&self, login_id: &str) -> Result<String, String> {
        self.logins
            .lock()
            .map_err(|_| "accounts lock poisoned".to_string())?
            .get(login_id)
            .map(|pending| pending.session_id.clone())
            .ok_or_else(|| format!("no sign-in in progress: {login_id}"))
    }

    fn live_sessions(&self, registry: &Registry) -> Vec<AccountSessionUse> {
        let Ok(mut sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        sessions.retain(|tab_id, _| registry.has_live_session(tab_id));
        sessions.values().flatten().cloned().collect()
    }

    fn store(&self) -> Result<&AccountsStore, String> {
        self.store
            .as_ref()
            .ok_or_else(|| "accounts are unavailable on this host (no home directory)".to_string())
    }
}

/// What the sidecar's `launch` op returns for one login home.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountLaunch {
    #[serde(default)]
    env: HashMap<String, String>,
    credential_path: Option<String>,
    login_command: Option<Vec<String>>,
    /// Lines typed into the login terminal once the command has started.
    #[serde(default)]
    login_input: Vec<String>,
    login_input_delay_ms: Option<u64>,
    instructions: Option<String>,
}

/// Default wait before (and between) scripted login input lines: long enough
/// for a TUI to start and take the terminal.
const LOGIN_INPUT_DELAY_MS: u64 = 2500;

/// Types a plugin's scripted login input (e.g. Pi's `/login openai-codex`)
/// into the login terminal in the background, one Enter-terminated line at a
/// time. Stops as soon as the session is gone.
fn type_login_input(
    registry: &Registry,
    session_id: &str,
    lines: Vec<String>,
    delay_ms: Option<u64>,
) {
    if lines.is_empty() {
        return;
    }
    let Ok(session) = registry.session(session_id) else {
        return;
    };
    let delay = Duration::from_millis(delay_ms.unwrap_or(LOGIN_INPUT_DELAY_MS));
    thread::spawn(move || {
        for line in lines {
            thread::sleep(delay);
            if session.write(&format!("{line}\r")).is_err() {
                return;
            }
        }
    });
}

fn providers_for(
    registry: &Registry,
    project_root: Option<&str>,
) -> Result<Vec<AccountProviderInfo>, String> {
    let value = registry
        .plugins()
        .accounts_request(json!({ "op": "providers", "root": project_root }))
        .map_err(|error| error.to_string())?;
    serde_json::from_value(value).map_err(|error| format!("invalid account providers: {error}"))
}

fn launch_op(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    project_root: Option<&str>,
) -> Result<AccountLaunch, String> {
    let value = provider_op(registry, "launch", provider, home, project_root)?;
    serde_json::from_value(value).map_err(|error| format!("invalid account launch: {error}"))
}

fn activate_op(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    env: &[(String, String)],
    project_root: Option<&str>,
) -> Result<Value, String> {
    let env: HashMap<&str, &str> = env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    registry
        .plugins()
        .accounts_request(json!({
            "op": "activate",
            "pluginId": provider.plugin_id,
            "providerId": provider.provider_id,
            "home": home,
            "env": env,
            "root": project_root,
        }))
        .map_err(|error| error.to_string())
}

/// Whether a shared token (the plugin API's `SharedToken`, passed through as
/// JSON) is an OAuth sign-in rather than an API key.
fn is_oauth(token: &Value) -> bool {
    token.get("type").and_then(Value::as_str) == Some("oauth")
}

/// When an OAuth token's access token expires (Unix ms): the newer token
/// expires later. An API key has none.
fn token_expires(token: &Value) -> i64 {
    token.get("expires").and_then(Value::as_i64).unwrap_or(0)
}

/// The newest token among `sources`, with the login it came from.
fn freshest_token<'a>(
    registry: &Registry,
    sources: &[(&'a AccountLogin, &AccountProviderInfo)],
    project_root: Option<&str>,
) -> Option<(&'a AccountLogin, Value)> {
    sources
        .iter()
        .filter_map(|(login, info)| {
            let token =
                read_token_op(registry, info, login.home.as_deref(), project_root).ok()??;
            Some((*login, token))
        })
        .max_by_key(|(_, token)| token_expires(token))
}

fn read_token_op(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    project_root: Option<&str>,
) -> Result<Option<Value>, String> {
    let value = provider_op(registry, "readToken", provider, home, project_root)?;
    Ok((!value.is_null()).then_some(value))
}

fn write_token_op(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    token: &Value,
    project_root: Option<&str>,
) -> Result<(), String> {
    registry
        .plugins()
        .accounts_request(json!({
            "op": "writeToken",
            "pluginId": provider.plugin_id,
            "providerId": provider.provider_id,
            "home": home,
            "token": token,
            "root": project_root,
        }))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn identify_op(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    project_root: Option<&str>,
) -> Result<Value, String> {
    provider_op(registry, "identify", provider, home, project_root)
}

fn registry_usage(
    registry: &Registry,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    project_root: Option<&str>,
) -> Result<Value, String> {
    provider_op(registry, "usage", provider, home, project_root)
}

fn provider_op(
    registry: &Registry,
    op: &str,
    provider: &AccountProviderInfo,
    home: Option<&str>,
    project_root: Option<&str>,
) -> Result<Value, String> {
    registry
        .plugins()
        .accounts_request(json!({
            "op": op,
            "pluginId": provider.plugin_id,
            "providerId": provider.provider_id,
            "home": home,
            "root": project_root,
        }))
        .map_err(|error| error.to_string())
}

/// Adds the harness's own default login for every harness x provider pair that
/// lacks one, so an existing `~/.claude` sign-in shows up without setup.
///
/// Also drops default logins a still-loaded plugin no longer declares — the
/// ones a plugin left behind when it moved from `usageLimits` to
/// `defineAccounts` and its provider id changed. A default login holds no
/// credentials, and a plugin that is merely not loaded here keeps its logins.
fn ensure_default_logins(state: &mut AccountsState, providers: &[AccountProviderInfo]) {
    state.logins.retain(|login| {
        let plugin_loaded = providers.iter().any(|p| p.plugin_id == login.plugin_id);
        login.home.is_some() || !plugin_loaded || provider_for_login(providers, login).is_some()
    });
    let now = now_ms();
    for provider in providers {
        for agent_id in &provider.agent_ids {
            let id = core_accounts::default_login_id(agent_id, &provider.provider_id);
            if state.logins.iter().any(|login| login.id == id) {
                continue;
            }
            state.logins.push(AccountLogin {
                id,
                plugin_id: provider.plugin_id.clone(),
                provider_id: provider.provider_id.clone(),
                provider: provider.provider.clone(),
                agent_id: agent_id.clone(),
                home: None,
                credential_path: None,
                identity: None,
                created_at: now,
                updated_at: now,
                token_group: None,
            });
        }
    }
}

/// What every harness x provider pair resolves to in `project_root`.
fn effective_bindings(
    state: &AccountsState,
    providers: &[AccountProviderInfo],
    project_root: Option<&str>,
) -> Vec<AccountEffectiveBinding> {
    let mut effective: Vec<AccountEffectiveBinding> = Vec::new();
    for provider in providers {
        for agent_id in &provider.agent_ids {
            if effective
                .iter()
                .any(|entry| entry.agent_id == *agent_id && entry.provider == provider.provider)
            {
                continue;
            }
            let login =
                core_accounts::resolve_login(state, agent_id, &provider.provider, project_root);
            let scope =
                core_accounts::effective_binding(state, agent_id, &provider.provider, project_root)
                    .filter(|(key, _)| {
                        login.is_some_and(|login| core_accounts::account_key(login) == *key)
                    })
                    .map(|(_, scope)| scope);
            effective.push(AccountEffectiveBinding {
                agent_id: agent_id.clone(),
                provider: provider.provider.clone(),
                account_key: login.map(core_accounts::account_key),
                login_id: login.map(|login| login.id.clone()),
                scope,
            });
        }
    }
    effective
}

fn provider_for_login<'a>(
    providers: &'a [AccountProviderInfo],
    login: &AccountLogin,
) -> Option<&'a AccountProviderInfo> {
    providers.iter().find(|provider| {
        provider.plugin_id == login.plugin_id && provider.provider_id == login.provider_id
    })
}

/// One login per account that can report usage. Loading once per account, not
/// once per harness, keeps rate-limited endpoints (Anthropic's) from 429ing.
fn usage_targets<'a>(
    state: &'a AccountsState,
    providers: &'a [AccountProviderInfo],
    account_keys: Option<&[String]>,
) -> Vec<(String, &'a AccountLogin, &'a AccountProviderInfo)> {
    let mut targets: Vec<(String, &AccountLogin, &AccountProviderInfo)> = Vec::new();
    for login in &state.logins {
        let Some(provider) = provider_for_login(providers, login) else {
            continue;
        };
        if provider.primary_limit_id.is_none() {
            continue;
        }
        let key = core_accounts::account_key(login);
        if account_keys.is_some_and(|keys| !keys.contains(&key)) {
            continue;
        }
        if !targets.iter().any(|(existing, _, _)| *existing == key) {
            targets.push((key, login, provider));
        }
    }
    targets
}

/// Strips terminal control sequences, returning the visible text and every
/// http(s) URL printed in it — including OSC 8 hyperlink targets, which some
/// login commands print instead of a bare URL.
fn terminal_text(bytes: &[u8]) -> (String, Vec<String>) {
    let raw = String::from_utf8_lossy(bytes);
    let mut text = String::with_capacity(raw.len());
    let mut osc_targets = Vec::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if c == '\r' {
                continue;
            }
            if !c.is_control() || c == '\n' || c == '\t' {
                text.push(c);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                let mut body = String::new();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                    body.push(next);
                }
                if let Some(target) = body
                    .strip_prefix("8;")
                    .and_then(|rest| rest.split_once(';'))
                {
                    if !target.1.is_empty() {
                        osc_targets.push(target.1.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    let mut urls = Vec::new();
    for url in osc_targets.into_iter().chain(extract_urls(&text)) {
        if is_http_url(&url) && !urls.contains(&url) {
            urls.push(url);
        }
    }
    (text, urls)
}

fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("http") {
        let candidate = &rest[start..];
        let end = candidate
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | ')' | ']')
            })
            .unwrap_or(candidate.len());
        let url = candidate[..end].trim_end_matches(['.', ',', ';', ':']);
        if is_http_url(url) {
            urls.push(url.to_string());
        }
        rest = &candidate[end.max(4)..];
    }
    urls
}

fn is_http_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && url.len() > "https://".len()
}

fn tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_text_strips_escapes_and_finds_urls() {
        let bytes = b"\x1b[1mOpen\x1b[0m https://claude.ai/oauth?code=1.\r\n\x1b]8;;https://x.ai/device\x07link\x1b]8;;\x07\n";
        let (text, urls) = terminal_text(bytes);
        assert_eq!(text, "Open https://claude.ai/oauth?code=1.\nlink\n");
        assert_eq!(
            urls,
            vec![
                "https://x.ai/device".to_string(),
                "https://claude.ai/oauth?code=1".to_string()
            ]
        );
    }

    #[test]
    fn extract_urls_ignores_plain_words() {
        assert!(extract_urls("httpbin and http:// only").is_empty());
    }

    #[test]
    fn tail_keeps_char_boundaries() {
        assert_eq!(tail("héllo", 4), "llo");
    }

    fn provider_info(plugin_id: &str, provider_id: &str) -> AccountProviderInfo {
        AccountProviderInfo {
            plugin_id: plugin_id.to_string(),
            provider_id: provider_id.to_string(),
            provider: "anthropic".to_string(),
            title: "Anthropic".to_string(),
            agent_ids: vec!["cc".to_string()],
            dashboard_url: None,
            icon_path: None,
            plugin_dir: None,
            has_login: true,
            login_instructions: None,
            multi_account: true,
            swaps: false,
            shared_token_kind: None,
            shared_token_writable: false,
            identifies: true,
            legacy: false,
            primary_limit_id: None,
            refresh_interval_ms: None,
        }
    }

    fn default_login(id: &str, plugin_id: &str, provider_id: &str) -> AccountLogin {
        AccountLogin {
            id: id.to_string(),
            plugin_id: plugin_id.to_string(),
            provider_id: provider_id.to_string(),
            provider: provider_id.to_string(),
            agent_id: "cc".to_string(),
            home: None,
            credential_path: None,
            identity: None,
            created_at: 0,
            updated_at: 0,
            token_group: None,
        }
    }

    #[test]
    fn default_logins_follow_a_plugin_that_renamed_its_provider() {
        let mut state = core_accounts::empty_state();
        state
            .logins
            .push(default_login("legacy", "p", "claude-code"));
        state.logins.push(default_login("other-plugin", "q", "x"));
        let mut kept = default_login("pragma-owned", "p", "claude-code");
        kept.home = Some("/h/1".to_string());
        state.logins.push(kept);
        ensure_default_logins(&mut state, &[provider_info("p", "anthropic:cc")]);
        let ids: Vec<&str> = state.logins.iter().map(|login| login.id.as_str()).collect();
        assert_eq!(
            ids,
            ["other-plugin", "pragma-owned", "default:cc:anthropic:cc"]
        );
    }

    #[test]
    fn usage_targets_load_each_account_once() {
        let provider = AccountProviderInfo {
            plugin_id: "p".to_string(),
            provider_id: "anthropic".to_string(),
            provider: "anthropic".to_string(),
            title: "Anthropic".to_string(),
            agent_ids: vec!["a".to_string(), "b".to_string()],
            dashboard_url: None,
            icon_path: None,
            plugin_dir: None,
            has_login: true,
            login_instructions: None,
            multi_account: true,
            swaps: false,
            shared_token_kind: None,
            shared_token_writable: false,
            identifies: true,
            legacy: false,
            primary_limit_id: Some("five-hour".to_string()),
            refresh_interval_ms: None,
        };
        let mut state = core_accounts::empty_state();
        let identity = Some(pragma_constants::AccountIdentity {
            id: "org".to_string(),
            email: None,
            name: None,
            plan: None,
        });
        for (id, agent) in [("1", "a"), ("2", "b")] {
            state.logins.push(AccountLogin {
                id: id.to_string(),
                plugin_id: "p".to_string(),
                provider_id: "anthropic".to_string(),
                provider: "anthropic".to_string(),
                agent_id: agent.to_string(),
                home: None,
                credential_path: None,
                identity: identity.clone(),
                created_at: 0,
                updated_at: 0,
                token_group: None,
            });
        }
        let providers = [provider];
        let targets = usage_targets(&state, &providers, None);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "anthropic:org");
    }
}
