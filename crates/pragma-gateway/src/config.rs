use std::path::PathBuf;

/// Runtime configuration for the localhost HTTP gateway.
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    /// Unix socket path for the `pragma-server` instance to front.
    pub socket_path: PathBuf,
    /// TCP port to bind on `127.0.0.1`; `0` asks the OS for an ephemeral port.
    pub port: u16,
    /// Bearer token required by authenticated routes.
    pub token: String,
    /// Path to the discovery file written beside the daemon socket.
    pub discovery_path: PathBuf,
}

impl GatewayConfig {
    /// Creates a gateway configuration.
    #[must_use]
    pub fn new(socket_path: PathBuf, port: u16, token: String, discovery_path: PathBuf) -> Self {
        Self {
            socket_path,
            port,
            token,
            discovery_path,
        }
    }
}
