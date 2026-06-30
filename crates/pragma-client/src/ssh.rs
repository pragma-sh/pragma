//! SSH streamlocal bridge for remote Pragma hosts.
//!
//! The server remains unaware of SSH. This module opens an SSH client session,
//! runs a bootstrap exec command, then exposes a local Unix socket. Every local
//! inbound connection maps to one `channel_open_direct_streamlocal` channel to
//! the remote `daemon.sock`, and bytes are copied without protocol awareness.

use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use russh::client::{self, Config, Handle, Handler};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::ChannelMsg;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixListener;

/// Authentication settings for a remote SSH host.
#[derive(Clone, Debug)]
pub enum RemoteAuth {
    /// Try SSH "none" authentication. Useful for tests and hosts configured for
    /// external auth mechanisms.
    None,
    /// Authenticate with a password supplied by the native client shell/UI.
    Password(String),
    /// Authenticate with keys held by the running SSH agent (`SSH_AUTH_SOCK`).
    /// The default, most-convenient method.
    Agent,
    /// Authenticate with a private key file, optionally passphrase-protected.
    Key {
        /// Path to the private key on the local machine (e.g. `~/.ssh/id_ed25519`).
        path: PathBuf,
        /// Passphrase, if the key is encrypted.
        passphrase: Option<String>,
    },
}

/// Connection parameters for a remote SSH host, without bridge specifics. Used
/// for one-shot [`ssh_exec`] probes (git/path/version checks) before the
/// streamlocal bridge is established.
#[derive(Clone, Debug)]
pub struct SshConnectConfig {
    /// SSH server hostname or IP.
    pub host: String,
    /// SSH server port.
    pub port: u16,
    /// SSH username.
    pub user: String,
    /// SSH authentication method.
    pub auth: RemoteAuth,
}

/// Result of a one-shot remote command.
#[derive(Clone, Debug)]
pub struct SshExecResult {
    /// Process exit status (`-1` if the remote closed without reporting one).
    pub exit_code: i32,
    /// Captured stdout.
    pub stdout: String,
    /// Captured stderr.
    pub stderr: String,
}

/// Configuration for one remote host bridge.
#[derive(Clone, Debug)]
pub struct SshBridgeConfig {
    /// SSH server hostname or IP.
    pub host: String,
    /// SSH server port.
    pub port: u16,
    /// SSH username.
    pub user: String,
    /// SSH authentication method.
    pub auth: RemoteAuth,
    /// Remote `daemon.sock` path to forward with `direct-streamlocal`.
    pub remote_socket_path: String,
    /// Local Unix socket the sync Pragma client should connect to.
    pub local_socket_path: PathBuf,
    /// One-shot command that ensures `pragma-server` is running on the host.
    pub bootstrap_command: String,
}

/// Errors returned while starting or running the SSH bridge.
#[derive(Debug, Error)]
pub enum SshBridgeError {
    /// Local I/O failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The SSH library returned an error.
    #[error("ssh error: {0}")]
    Ssh(#[from] russh::Error),
    /// Authentication did not succeed.
    #[error("ssh authentication failed")]
    AuthFailed,
    /// A private key could not be loaded or decoded.
    #[error("ssh key error: {0}")]
    Key(String),
    /// The SSH agent could not be reached or returned an error.
    #[error("ssh agent error: {0}")]
    Agent(String),
    /// The bootstrap command returned a non-zero status.
    #[error("remote bootstrap failed with status {0}")]
    BootstrapFailed(u32),
    /// The background bridge did not report readiness in time.
    #[error("ssh bridge did not become ready")]
    NotReady,
}

/// Starts a background SSH streamlocal bridge and returns the local socket path.
pub fn start_ssh_bridge(config: SshBridgeConfig) -> Result<PathBuf, SshBridgeError> {
    let local_socket_path = config.local_socket_path.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_io()
            .enable_time()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = ready_tx.send(Err(SshBridgeError::Io(error)));
                return;
            }
        };
        runtime.block_on(async move {
            if let Err(error) = run_bridge(config, ready_tx).await {
                eprintln!("pragma-client ssh bridge stopped: {error}");
            }
        });
    });
    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(local_socket_path),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(SshBridgeError::NotReady),
    }
}

async fn run_bridge(
    config: SshBridgeConfig,
    ready_tx: mpsc::SyncSender<Result<(), SshBridgeError>>,
) -> Result<(), SshBridgeError> {
    let mut handle = connect(&config.host, config.port).await?;
    authenticate(&mut handle, &config.user, &config.auth).await?;
    bootstrap(&handle, &config.bootstrap_command).await?;

    let _ = std::fs::remove_file(&config.local_socket_path);
    if let Some(parent) = config.local_socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(&config.local_socket_path)?;
    set_socket_permissions(&config.local_socket_path)?;
    let _ = ready_tx.send(Ok(()));

    let handle = Arc::new(handle);
    loop {
        let (mut local_stream, _) = listener.accept().await?;
        let handle = Arc::clone(&handle);
        let remote_socket_path = config.remote_socket_path.clone();
        tokio::spawn(async move {
            let Ok(channel) = handle
                .channel_open_direct_streamlocal(remote_socket_path)
                .await
            else {
                let _ = local_stream.shutdown().await;
                return;
            };
            let mut channel_stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut local_stream, &mut channel_stream).await;
            let _ = channel_stream.shutdown().await;
        });
    }
}

async fn connect(host: &str, port: u16) -> Result<Handle<TrustServerKey>, SshBridgeError> {
    let ssh_config = Arc::new(Config {
        nodelay: true,
        ..Config::default()
    });
    Ok(client::connect(ssh_config, (host, port), TrustServerKey).await?)
}

async fn authenticate(
    handle: &mut Handle<TrustServerKey>,
    user: &str,
    auth: &RemoteAuth,
) -> Result<(), SshBridgeError> {
    let success = match auth {
        RemoteAuth::None => handle.authenticate_none(user).await?.success(),
        RemoteAuth::Password(password) => handle
            .authenticate_password(user, password.as_str())
            .await?
            .success(),
        RemoteAuth::Key { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref())
                .map_err(|error| SshBridgeError::Key(error.to_string()))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle.authenticate_publickey(user, key).await?.success()
        }
        RemoteAuth::Agent => authenticate_agent(handle, user).await?,
    };
    if success {
        Ok(())
    } else {
        Err(SshBridgeError::AuthFailed)
    }
}

/// Tries each identity in the running SSH agent until one authenticates.
async fn authenticate_agent(
    handle: &mut Handle<TrustServerKey>,
    user: &str,
) -> Result<bool, SshBridgeError> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|error| SshBridgeError::Agent(error.to_string()))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| SshBridgeError::Agent(error.to_string()))?;
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let result = handle
            .authenticate_publickey_with(user, key, None, &mut agent)
            .await
            .map_err(|error| SshBridgeError::Agent(error.to_string()))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Runs a single command on the remote host over a fresh authenticated SSH
/// session and returns its captured output. Synchronous wrapper around a private
/// runtime so the desktop app can call it from a blocking command.
pub fn ssh_exec(config: &SshConnectConfig, command: &str) -> Result<SshExecResult, SshBridgeError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    runtime.block_on(async move {
        let mut handle = connect(&config.host, config.port).await?;
        authenticate(&mut handle, &config.user, &config.auth).await?;
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = -1;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = i32::try_from(exit_status).unwrap_or(-1);
                }
                _ => {}
            }
        }
        Ok(SshExecResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    })
}

async fn bootstrap(
    handle: &client::Handle<TrustServerKey>,
    command: &str,
) -> Result<(), SshBridgeError> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                return Err(SshBridgeError::BootstrapFailed(exit_status));
            }
            ChannelMsg::ExitStatus { .. } | ChannelMsg::Close => return Ok(()),
            _ => {}
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct TrustServerKey;

impl Handler for TrustServerKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[cfg(unix)]
fn set_socket_permissions(path: &PathBuf) -> Result<(), SshBridgeError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}
