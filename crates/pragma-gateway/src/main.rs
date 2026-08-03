mod auth;
mod client;
mod config;
mod devices;
mod error;
mod http;
mod push;
mod routes;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use auth::{read_or_create_token, remove_stale_or_refuse, write_discovery, GatewayDiscovery};
use clap::Parser;
use config::GatewayConfig;
use error::{GatewayError, GatewayResult};
use http::{serve, AppState};
use pragma_constants::CONSTANTS;
use tiny_http::Server;

#[derive(Debug, Parser)]
#[command(about = "Localhost HTTP gateway for pragma-server")]
struct Args {
    /// Existing pragma-server Unix socket path.
    #[arg(long, env = "PRAGMA_SERVER_SOCKET")]
    socket: Option<PathBuf>,
    /// App data directory used to resolve the channel socket when --socket is absent.
    #[arg(long, env = "PRAGMA_APP_DATA_DIR")]
    app_data_dir: Option<PathBuf>,
    /// Instance channel used to resolve the socket when --socket is absent.
    #[arg(long, env = "PRAGMA_SERVER_CHANNEL")]
    channel: Option<String>,
    /// Port to bind on 127.0.0.1; 0 means ephemeral.
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Bearer token. A random token is generated when omitted.
    #[arg(long)]
    token: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The gateway holds a socket per in-flight HTTP request plus one to the
    // server; like every Pragma host process it inherits launchd's 256-fd soft
    // limit and raises it before opening anything. Best-effort — see
    // `pragma_protocol::limits`.
    if let Err(error) = pragma_protocol::limits::raise_open_file_limit() {
        eprintln!("could not raise the open-file limit: {error}");
    }
    let args = Args::parse();
    run(args).map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
}

fn run(args: Args) -> GatewayResult<()> {
    let socket_path = resolve_socket_path(&args)?;
    let discovery_path = socket_path.with_file_name(CONSTANTS.gateway.discovery_file.as_str());
    let token = if let Some(token) = args.token {
        token
    } else {
        let token_path = socket_path.with_file_name(CONSTANTS.gateway.token_file.as_str());
        read_or_create_token(&token_path)?
    };
    let config = GatewayConfig::new(socket_path, args.port, token, discovery_path);

    remove_stale_or_refuse(
        &config.discovery_path,
        CONSTANTS.daemon.protocol_version.get(),
    )?;
    let client = client::GatewayClient::new(config.socket_path.clone());
    client.ensure_protocol()?;

    let server = Server::http(("127.0.0.1", config.port))
        .map_err(|error| GatewayError::Http(error.to_string()))?;
    let port = bound_port(&server)?;
    write_discovery(
        &config.discovery_path,
        &GatewayDiscovery {
            port,
            token: config.token.clone(),
            pid: std::process::id(),
            protocol_version: client.protocol_version(),
        },
    )?;

    let devices = Arc::new(Mutex::new(devices::DeviceRegistry::new(
        config
            .socket_path
            .with_file_name(CONSTANTS.gateway.devices_file.as_str()),
    )));
    let presence = push::DesktopPresence::default();
    // Push is best-effort infrastructure: a gateway that cannot build an HTTPS
    // client still serves every other route, it just never wakes a phone.
    let push_worker = push::PushWorker::new(client.clone(), Arc::clone(&devices), presence.clone());
    if let Some(worker) = push_worker.as_ref() {
        worker.start();
    } else {
        eprintln!("push notifications are disabled: no HTTPS client could be built");
    }
    let state = AppState {
        client,
        token: config.token,
        gateway_version: env!("CARGO_PKG_VERSION"),
        pending_spawn_streams: Arc::new(Mutex::new(HashMap::default())),
        devices,
        push: push_worker,
        presence,
    };
    // Model providers may invoke slow host tools. Keep catalog refresh off the
    // startup path so clients can use the newly advertised gateway immediately.
    let plugin_client = state.client.clone();
    thread::spawn(move || {
        if let Err(error) = plugin_client.reload_plugins() {
            eprintln!("plugin catalog reload after discovery write failed: {error}");
        }
    });
    serve(&server, &state);
    Ok(())
}

fn resolve_socket_path(args: &Args) -> GatewayResult<PathBuf> {
    if let Some(socket) = &args.socket {
        return Ok(socket.clone());
    }
    if let Some(socket) = std::env::var_os("PRAGMA_DAEMON_SOCKET") {
        return Ok(PathBuf::from(socket));
    }
    let app_data_dir = args.app_data_dir.as_ref().ok_or_else(|| {
        GatewayError::InvalidPayload("--socket or --app-data-dir is required".to_string())
    })?;
    let channel = args
        .channel
        .as_deref()
        .unwrap_or(pragma_protocol::PROD_CHANNEL);
    Ok(server_dir(app_data_dir, channel).join(pragma_platform::ipc::socket_file_name()))
}

fn server_dir(app_data_dir: &Path, channel: &str) -> PathBuf {
    if cfg!(target_os = "linux") {
        std::env::var_os("XDG_RUNTIME_DIR").map_or_else(
            || app_data_dir.join(channel),
            |dir| PathBuf::from(dir).join(channel),
        )
    } else if channel == pragma_protocol::PROD_CHANNEL {
        app_data_dir.to_path_buf()
    } else {
        app_data_dir.join(channel)
    }
}

fn bound_port(server: &Server) -> GatewayResult<u16> {
    let address = server.server_addr().to_string();
    address
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .ok_or_else(|| GatewayError::Http(format!("could not read bound port from {address}")))
}
