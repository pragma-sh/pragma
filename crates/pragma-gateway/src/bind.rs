//! Choosing the gateway's localhost port.
//!
//! The port is runtime-assigned, but a replacement gateway takes its
//! predecessor's port when it can. The remote-access tunnel is started once
//! against whatever port `gateway.json` advertised at the time, and the gateway
//! is replaced underneath it routinely: after every update (a protocol-version
//! mismatch evicts the old one) and whenever the desktop finds it unhealthy. A
//! fresh ephemeral port each time leaves the tunnel forwarding to nothing, and
//! the phone reports "couldn't reach the desktop" until remote access is
//! toggled — which, for an anonymous tunnel, also mints a new public URL and
//! forces a re-pair. Reusing the port keeps both the tunnel and its URL valid.

use std::thread;
use std::time::{Duration, Instant};

use tiny_http::Server;

use crate::error::{GatewayError, GatewayResult};

/// How long to keep retrying a predecessor's port. A gateway that was just
/// killed releases its listener as the process exits, which is not instant.
const PREVIOUS_PORT_WAIT: Duration = Duration::from_secs(1);
const PREVIOUS_PORT_RETRY: Duration = Duration::from_millis(50);

/// Binds the gateway on 127.0.0.1.
///
/// An explicit `requested` port (`--port`) is honoured exactly. Otherwise the
/// `previous` gateway's port is tried first, and an ephemeral port is the
/// fallback when something else now holds it.
pub fn bind_server(requested: u16, previous: Option<u16>) -> GatewayResult<Server> {
    if requested != 0 {
        return bind(requested);
    }
    if let Some(port) = previous.filter(|port| *port != 0) {
        if let Some(server) = bind_within(port, PREVIOUS_PORT_WAIT) {
            return Ok(server);
        }
        eprintln!("previous gateway port {port} is taken; using a new port");
    }
    bind(0)
}

/// Retries `port` until it binds or `wait` elapses.
fn bind_within(port: u16, wait: Duration) -> Option<Server> {
    let deadline = Instant::now() + wait;
    loop {
        if let Ok(server) = bind(port) {
            return Some(server);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(PREVIOUS_PORT_RETRY);
    }
}

fn bind(port: u16) -> GatewayResult<Server> {
    Server::http(("127.0.0.1", port)).map_err(|error| GatewayError::Http(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::bind_server;

    fn port_of(server: &tiny_http::Server) -> u16 {
        server.server_addr().to_ip().expect("ip listener").port()
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port()
    }

    #[test]
    fn reuses_the_previous_gateways_port_when_it_is_free() {
        let previous = free_port();

        let server = bind_server(0, Some(previous)).expect("bind");

        assert_eq!(port_of(&server), previous);
    }

    #[test]
    fn falls_back_to_a_new_port_when_the_previous_one_is_taken() {
        let holder = TcpListener::bind("127.0.0.1:0").expect("bind");
        let taken = holder.local_addr().expect("addr").port();

        let server = bind_server(0, Some(taken)).expect("bind");

        assert_ne!(port_of(&server), taken);
    }

    #[test]
    fn an_explicit_port_wins_over_the_previous_one() {
        let requested = free_port();

        let server = bind_server(requested, Some(free_port())).expect("bind");

        assert_eq!(port_of(&server), requested);
    }
}
