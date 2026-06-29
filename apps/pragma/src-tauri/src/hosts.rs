//! Per-project host routing.
//!
//! Every project lives on a host: the local machine (`local`) or a remote box
//! reached over an SSH streamlocal bridge. This registry owns the client-local
//! [`RouterDb`] (the project → host map) plus one [`PtyClient`] per host, and
//! resolves which client a command should talk to. PTY/RPC for a local project
//! go to the managed-local server; for a remote project they travel the bridge
//! to that host's `pragma-server`. With no remotes registered every lookup
//! resolves to `local`, so local projects behave exactly as before.

use std::collections::HashMap;
use std::sync::Mutex;

use pragma_client::router::RouterDb;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::pty::PtyClient;

/// The reserved host id for the local machine.
pub const LOCAL_HOST: &str = "local";

/// A connected remote host: its routing client and a label for diagnostics.
///
/// The SSH bridge that backs `client`'s socket runs on its own detached thread
/// (see `pragma_client::start_ssh_bridge`), so there is no handle to retain here.
pub struct RemoteHost {
    /// Client bound to the bridge's local socket end.
    pub client: PtyClient,
    /// Human-facing label (e.g. `user@host`) for diagnostics.
    pub label: String,
}

/// Registry of hosts and the project → host routing it resolves.
pub struct Hosts {
    local: PtyClient,
    router: RouterDb,
    remotes: Mutex<HashMap<String, RemoteHost>>,
    /// session id → host id, recorded on spawn so session-keyed PTY ops
    /// (write/resize/kill/attach) reach the host the session actually runs on.
    sessions: Mutex<HashMap<String, String>>,
}

impl Hosts {
    /// Creates the registry around the managed-local client and router DB.
    pub fn new(local: PtyClient, router: RouterDb) -> Self {
        Self {
            local,
            router,
            remotes: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// The client-local router DB (project → host map).
    pub fn router(&self) -> &RouterDb {
        &self.router
    }

    /// The local managed-server client.
    pub fn local(&self) -> PtyClient {
        self.local.clone()
    }

    /// Returns the client for a host id, erroring if a named remote host is not
    /// currently connected.
    pub fn client_for_host(&self, host_id: &str) -> AppResult<PtyClient> {
        if host_id == LOCAL_HOST {
            return Ok(self.local.clone());
        }
        let remotes = self.remotes.lock()?;
        remotes
            .get(host_id)
            .map(|host| host.client.clone())
            .ok_or_else(|| AppError::Daemon(format!("remote host '{host_id}' is not connected")))
    }

    /// Resolves the host id a project is routed to, defaulting to `local` when
    /// no route is recorded. The route is keyed by the project's path.
    pub fn host_id_for_project_path(&self, project_path: &str) -> String {
        self.router
            .project_route(project_path)
            .ok()
            .flatten()
            .map_or_else(|| LOCAL_HOST.to_string(), |route| route.host_id)
    }

    /// Resolves the host id for a worktree (via its project).
    pub fn host_id_for_worktree(&self, db: &Db, worktree_id: &str) -> AppResult<String> {
        let worktree = db.worktree(worktree_id)?;
        let project = db.project(&worktree.project_id)?;
        Ok(self.host_id_for_project_path(&project.path))
    }

    /// Resolves the client for a worktree (via its project).
    pub fn for_worktree(&self, db: &Db, worktree_id: &str) -> AppResult<PtyClient> {
        self.client_for_host(&self.host_id_for_worktree(db, worktree_id)?)
    }

    /// Records the host a PTY session was spawned on.
    pub fn bind_session(&self, session_id: String, host_id: String) -> AppResult<()> {
        self.sessions.lock()?.insert(session_id, host_id);
        Ok(())
    }

    /// Drops a session's host binding (after kill).
    pub fn unbind_session(&self, session_id: &str) -> AppResult<()> {
        self.sessions.lock()?.remove(session_id);
        Ok(())
    }

    /// Resolves the client for a previously-spawned session, defaulting to the
    /// local client when the session is unknown (e.g. spawned before a restart).
    pub fn for_session(&self, session_id: &str) -> AppResult<PtyClient> {
        let host_id = self
            .sessions
            .lock()?
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| LOCAL_HOST.to_string());
        self.client_for_host(&host_id)
    }

    /// Every connected client (local + remotes), for broadcast operations like
    /// kill-by-cwd and mark-agents-seen that aren't tied to one host.
    pub fn all_clients(&self) -> AppResult<Vec<PtyClient>> {
        let remotes = self.remotes.lock()?;
        let mut clients = Vec::with_capacity(remotes.len() + 1);
        clients.push(self.local.clone());
        clients.extend(remotes.values().map(|host| host.client.clone()));
        Ok(clients)
    }

    /// Registers a connected remote host under `host_id`, replacing any prior
    /// entry.
    pub fn register_remote(&self, host_id: String, host: RemoteHost) -> AppResult<()> {
        log::info!("registered remote host '{host_id}' ({})", host.label);
        self.remotes.lock()?.insert(host_id, host);
        Ok(())
    }
}
