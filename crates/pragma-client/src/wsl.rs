//! WSL bridge: reaching a Linux `pragma-server` running inside a distribution.
//!
//! A WSL session is a full Linux terminal, so it is served by the ordinary
//! Linux `pragma-server` running unchanged inside the distribution — not by the
//! Windows server. That is deliberate: the agent plugins (`pragma-cli`, and the
//! opencode and Claude hooks) run *inside* WSL and connect to that Linux Unix
//! socket. A Windows-native server could never serve them.
//!
//! # Why a stdio relay
//!
//! WSL2 is a virtual machine. It cannot connect to a Windows named pipe, and
//! Windows cannot open the Linux `AF_UNIX` socket inside it, so the two worlds
//! need something that crosses the boundary. Two options were available:
//!
//! - **Forward the socket over localhost TCP.** WSL2's default
//!   `localhostForwarding` makes a port opened inside the distribution
//!   reachable from Windows. Rejected: it means opening a TCP listener that any
//!   local process — or, with the wrong firewall profile, another machine —
//!   can reach, replacing a socket whose owner-only permissions are the entire
//!   access control story. It also depends on a setting users can switch off,
//!   and needs port allocation and collision handling.
//!
//! - **Relay over a process's standard streams** (chosen). `wsl.exe` launches a
//!   process inside the distribution whose stdin and stdout are ordinary pipes
//!   on the Windows side. The Linux server is asked to relay its socket over
//!   those streams (`pragma-server --relay`). Nothing listens on a port, the
//!   Unix socket keeps its owner-only permissions and stays the only entry
//!   point, and it works on WSL1 and WSL2 under either networking mode.
//!
//! The cost is one `wsl.exe` process per bridged connection, which is the same
//! order as the one SSH channel per connection the remote-host bridge already
//! opens.
//!
//! Paths are never translated. The Linux server owns its own filesystem world
//! and is addressed exactly like a remote host, so `\\wsl$\` never appears.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use pragma_constants::{WslDistro, CONSTANTS};
use thiserror::Error;

use crate::bridge;

/// Enumerating distributions is a platform seam, shared with `pragma-server` so
/// a remote host can answer the same question about itself.
pub use pragma_platform::wsl::list_distros;

/// Errors raised while enumerating distributions or running the bridge.
#[derive(Debug, Error)]
pub enum WslError {
    /// Local I/O failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The distribution probe failed — no `wsl.exe`, or `wsl.exe` errored.
    #[error(transparent)]
    Probe(#[from] pragma_platform::wsl::WslError),
    /// `wsl.exe` is absent, i.e. WSL is not installed.
    #[error("WSL is not available on this machine: {0}")]
    Unavailable(String),
    /// `wsl.exe` ran but reported a failure.
    #[error("wsl exited with {status}: {message}")]
    Failed { status: String, message: String },
    /// No distribution is installed, so there is nothing to connect to.
    #[error("no WSL distribution is installed")]
    NoDistro,
    /// The named distribution is not installed.
    #[error("no WSL distribution named {0} is installed")]
    UnknownDistro(String),
    /// The background bridge did not report readiness in time.
    #[error("the WSL bridge did not become ready")]
    NotReady,
}

/// Configuration for one WSL bridge.
#[derive(Clone, Debug)]
pub struct WslBridgeConfig {
    /// Distribution to connect to. `None` uses the default distribution.
    pub distro: Option<String>,
    /// Local socket the synchronous Pragma client should connect to.
    pub local_socket_path: PathBuf,
    /// Command run inside the distribution to make sure a server is running
    /// before the first relay connects.
    pub bootstrap_command: String,
}

/// Channel the Linux server inside a distribution runs under.
///
/// Distinct from the Windows client's own channel so a WSL server and a
/// Windows-native server never resolve the same paths, and stable so a
/// reconnect finds the server a previous session started.
pub const WSL_CHANNEL: &str = "pragma-wsl";

/// Command that ensures a `pragma-server` is running inside the distribution.
///
/// Mirrors the remote-host bootstrap in `ssh_host.rs`: it pins
/// `PRAGMA_APP_DATA_DIR` and clears `XDG_RUNTIME_DIR` so the socket lands at a
/// deterministic `$HOME/.pragma/<channel>/<socket>` no matter what the
/// distribution's login environment does, and extends `PATH` with the places a
/// user-installed binary lands. `--detach` makes the server outlive this
/// one-shot command, and re-running it against an already-running server is
/// harmless: the server's own startup lock makes a second instance exit rather
/// than take over.
#[must_use]
pub fn default_bootstrap_command() -> String {
    let server = &CONSTANTS.platform.wsl.server_binary;
    format!(
        "PATH=\"$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:$PATH\" \
         env -u XDG_RUNTIME_DIR PRAGMA_APP_DATA_DIR=\"$HOME/.pragma\" \
         PRAGMA_SERVER_CHANNEL={WSL_CHANNEL} PRAGMA_DAEMON_CHANNEL={WSL_CHANNEL} \
         {server} --detach"
    )
}

/// Resolves the local socket a bridge to `distro` should expose.
///
/// The distribution name is sanitised because it is user-supplied and lands in
/// a filesystem path: a name carrying a separator would otherwise place the
/// socket outside `state_dir`.
#[must_use]
pub fn socket_path_for(state_dir: &std::path::Path, distro: &str) -> PathBuf {
    let sanitized: String = distro
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    bridge::bridge_socket_path(state_dir, &format!("wsl-{sanitized}"))
}

/// Resolves the distribution a bridge should use.
pub fn resolve_distro(requested: Option<&str>) -> Result<WslDistro, WslError> {
    let distros = list_distros()?.distros;
    match requested {
        Some(name) => distros
            .into_iter()
            .find(|distro| distro.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| WslError::UnknownDistro(name.to_string())),
        None => distros
            .iter()
            .find(|distro| distro.default)
            .or_else(|| distros.first())
            .cloned()
            .ok_or(WslError::NoDistro),
    }
}

/// Starts a background WSL bridge and returns the local socket path.
///
/// The returned socket behaves exactly like a local server socket, so the
/// caller connects to it with [`PragmaClient::new_socket`](crate::PragmaClient::new_socket)
/// and nothing above the transport knows WSL is involved.
pub fn start_wsl_bridge(config: WslBridgeConfig) -> Result<PathBuf, WslError> {
    let distro = resolve_distro(config.distro.as_deref())?;
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
                let _ = ready_tx.send(Err(WslError::Io(error)));
                return;
            }
        };
        runtime.block_on(async move {
            if let Err(error) = run_bridge(config, distro, ready_tx).await {
                eprintln!("pragma-client wsl bridge stopped: {error}");
            }
        });
    });

    match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => Ok(local_socket_path),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(WslError::NotReady),
    }
}

async fn run_bridge(
    config: WslBridgeConfig,
    distro: WslDistro,
    ready_tx: mpsc::SyncSender<Result<(), WslError>>,
) -> Result<(), WslError> {
    // Start (or confirm) the Linux server before advertising the socket, so the
    // first client to connect does not race the server's startup.
    bootstrap(&distro.name, &config.bootstrap_command).await?;

    let mut listener = bridge::bind_local_socket(&config.local_socket_path)?;
    let _ = ready_tx.send(Ok(()));

    let distro = Arc::new(distro.name);
    loop {
        let (local_stream, next) = bridge::accept(listener).await?;
        listener = next;
        let distro = Arc::clone(&distro);
        tokio::spawn(async move {
            if let Err(error) = relay_connection(&distro, local_stream).await {
                eprintln!("pragma-client wsl relay closed: {error}");
            }
        });
    }
}

/// Runs one relay process inside the distribution and pumps a connection through it.
async fn relay_connection(
    distro: &str,
    local_stream: pragma_platform::ipc::LocalStream,
) -> Result<(), WslError> {
    let mut command = tokio::process::Command::new(&CONSTANTS.platform.wsl.launcher);
    command
        .args([
            "-d",
            distro,
            "--exec",
            &CONSTANTS.platform.wsl.server_binary,
        ])
        .arg("--relay")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    hide_console(&mut command);
    let mut child = command.spawn()?;

    let stdin = child.stdin.take().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "wsl relay has no stdin")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "wsl relay has no stdout")
    })?;

    bridge::pump_split(local_stream, stdout, stdin).await?;
    let _ = child.wait().await;
    Ok(())
}

/// Keeps `wsl.exe` from flashing a console window.
///
/// `pragma_platform::process::hide_console` takes a `std::process::Command`;
/// tokio's has its own `creation_flags`, so the flag is applied here from the
/// same constant. On a non-Windows host there is no console to suppress —
/// `wsl.exe` does not exist there and the calls report `Unavailable` — so the
/// empty twin drops nothing.
fn hide_console(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        command.creation_flags(pragma_platform::process::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Runs the bootstrap command inside the distribution.
async fn bootstrap(distro: &str, command: &str) -> Result<(), WslError> {
    let mut launcher = tokio::process::Command::new(&CONSTANTS.platform.wsl.launcher);
    launcher.args(["-d", distro, "--exec", "/bin/sh", "-c", command]);
    hide_console(&mut launcher);
    let output = launcher
        .output()
        .await
        .map_err(|error| WslError::Unavailable(error.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(WslError::Failed {
        status: output.status.to_string(),
        message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    /// The bootstrap must pin the channel and clear `XDG_RUNTIME_DIR`, or the
    /// server binds a socket the relay then cannot find.
    #[test]
    fn the_bootstrap_pins_a_deterministic_socket_location() {
        let command = super::default_bootstrap_command();
        assert!(command.contains("env -u XDG_RUNTIME_DIR"), "{command}");
        assert!(
            command.contains(&format!("PRAGMA_SERVER_CHANNEL={}", super::WSL_CHANNEL)),
            "{command}"
        );
        assert!(command.contains("--detach"), "{command}");
    }

    /// A distribution name is user-supplied. Letting a separator through would
    /// put the bridge socket outside the state directory entirely.
    #[test]
    fn a_distribution_name_cannot_escape_the_state_directory() {
        let path = super::socket_path_for(std::path::Path::new("/state"), "../../etc/Ubuntu 22.04");
        assert_eq!(path.parent(), Some(std::path::Path::new("/state")));
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("a socket file name");
        assert!(name.starts_with("wsl-"), "{name}");
        assert!(!name.contains(".."), "{name}");
    }

    #[test]
    fn distributions_get_distinct_bridge_sockets() {
        let dir = std::path::Path::new("/state");
        assert_ne!(
            super::socket_path_for(dir, "Ubuntu"),
            super::socket_path_for(dir, "Debian")
        );
    }
}
