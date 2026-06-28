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

use russh::client::{self, Config, Handler};
use russh::keys::PublicKey;
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
    let mut handle = connect(&config).await?;
    authenticate(&mut handle, &config).await?;
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

async fn connect(
    config: &SshBridgeConfig,
) -> Result<client::Handle<TrustServerKey>, SshBridgeError> {
    let ssh_config = Arc::new(Config::default());
    let addr = (config.host.as_str(), config.port);
    Ok(client::connect(ssh_config, addr, TrustServerKey).await?)
}

async fn authenticate(
    handle: &mut client::Handle<TrustServerKey>,
    config: &SshBridgeConfig,
) -> Result<(), SshBridgeError> {
    let result = match &config.auth {
        RemoteAuth::None => handle.authenticate_none(&config.user).await?,
        RemoteAuth::Password(password) => {
            handle
                .authenticate_password(&config.user, password.as_str())
                .await?
        }
    };
    if result.success() {
        Ok(())
    } else {
        Err(SshBridgeError::AuthFailed)
    }
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
