pub mod response;
pub mod router;

use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Method, Request, Response, ResponseBox, Server, StatusCode};

use crate::auth::verify_bearer;
use crate::client::GatewayClient;
use crate::error::{GatewayError, GatewayResult};
use crate::http::response::error_response;
use crate::routes;

use self::router::gateway_router;

/// Spawn event streams held until the client opens the real events endpoint.
pub type PendingSpawnStreams = Arc<Mutex<HashMap<String, UnixStream>>>;

/// Shared HTTP application state.
#[derive(Clone)]
pub struct AppState {
    /// Gateway client wrapper.
    pub client: GatewayClient,
    /// Bearer token.
    pub token: String,
    /// Gateway package version.
    pub gateway_version: &'static str,
    /// Recently spawned session streams, kept briefly to cover race-to-attach.
    pub pending_spawn_streams: PendingSpawnStreams,
}

/// Runs the blocking `tiny_http` accept loop.
pub fn serve(server: &Server, state: &AppState) {
    let state = Arc::new(state.clone());
    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        thread::spawn(move || respond(request, &state));
    }
}

fn respond(mut request: Request, state: &AppState) {
    let response = if *request.method() == Method::Options {
        preflight_response()
    } else {
        dispatch(&mut request, state).unwrap_or_else(|error| error_response(&error).boxed())
    };
    let _ = request.respond(with_cors(response));
}

/// Answers a CORS preflight so webview clients (`tauri://localhost` in release
/// builds, `http://localhost:*` in dev) can call the gateway with the
/// `authorization` and `content-type` headers the SDK sends. Authentication
/// stays with the bearer token; the origin itself carries no trust.
fn preflight_response() -> ResponseBox {
    let mut response = Response::from_data(Vec::new()).with_status_code(StatusCode(204));
    response.add_header(header("access-control-allow-methods", "GET, POST, DELETE"));
    response.add_header(header(
        "access-control-allow-headers",
        "authorization, content-type",
    ));
    response.add_header(header("access-control-max-age", "86400"));
    response.boxed()
}

/// Adds the CORS allow-origin header every gateway response needs so webview
/// `fetch` calls are not blocked by the browser.
fn with_cors(mut response: ResponseBox) -> ResponseBox {
    response.add_header(header("access-control-allow-origin", "*"));
    response
}

fn header(field: &str, value: &str) -> Header {
    Header::from_bytes(field.as_bytes(), value.as_bytes()).expect("valid header")
}

fn dispatch(request: &mut Request, state: &AppState) -> GatewayResult<ResponseBox> {
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let matched = gateway_router()
        .match_route(&method, &url)
        .ok_or(GatewayError::NotFound)?;

    if matched.id != "health" && !authorized(request, &state.token) {
        return Err(GatewayError::Unauthorized);
    }

    let response = match matched.id {
        "health" => routes::health::health(state)?.boxed(),
        "version" => routes::health::version(state)?.boxed(),
        "rpc" => routes::rpc::rpc(request, state, &matched)?.boxed(),
        "sessions.spawn" => routes::sessions::spawn(request, state)?.boxed(),
        "sessions.events" => routes::sessions::events(state, &matched)?.boxed(),
        "sessions.input" => routes::sessions::input(request, state, &matched)?.boxed(),
        "sessions.resize" => routes::sessions::resize(request, state, &matched)?.boxed(),
        "sessions.kill" => routes::sessions::kill(state, &matched)?.boxed(),
        "sessions.killForCwd" => routes::sessions::kill_for_cwd(state, &matched)?.boxed(),
        "agents.reports" => routes::agents::report(request, state)?.boxed(),
        "agents.messages" => routes::agents::message(request, state)?.boxed(),
        "agents.decisions" => routes::agents::decision(request, state)?.boxed(),
        "agents.answers" => routes::agents::answer(request, state)?.boxed(),
        "agents.inputs" => routes::agents::input(request, state)?.boxed(),
        "agents.interrupts" => routes::agents::interrupt(request, state)?.boxed(),
        "agents.catalog" => routes::agents::catalog(state)?.boxed(),
        "agents.events" => routes::agents::events(state)?.boxed(),
        "assets.get" => routes::assets::get(state, &matched)?.boxed(),
        "control" => routes::control::control(request, state, &matched)?.boxed(),
        "agents.seen" => routes::agents::mark_seen(state, &matched)?.boxed(),
        "subscriptions.events" => routes::subscriptions::events(state, &matched)?.boxed(),
        _ => return Err(GatewayError::NotFound),
    };
    Ok(response)
}

fn authorized(request: &Request, token: &str) -> bool {
    let header = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("authorization"))
        .map(|header| header.value.as_str());
    verify_bearer(token, header)
}

/// Reads a JSON request body.
pub fn read_json<T: serde::de::DeserializeOwned>(request: &mut Request) -> GatewayResult<T> {
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body)?;
    serde_json::from_str(&body).map_err(|error| GatewayError::InvalidPayload(error.to_string()))
}

/// Reads a raw request body.
pub fn read_body(request: &mut Request) -> GatewayResult<Vec<u8>> {
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body)?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use tiny_http::Response;

    use super::{preflight_response, with_cors};

    fn header_value(response: &tiny_http::ResponseBox, field: &'static str) -> Option<String> {
        response
            .headers()
            .iter()
            .find(|header| header.field.equiv(field))
            .map(|header| header.value.as_str().to_string())
    }

    #[test]
    fn preflight_allows_sdk_methods_and_headers() {
        let response = preflight_response();
        assert_eq!(response.status_code().0, 204);
        assert_eq!(
            header_value(&response, "access-control-allow-methods").as_deref(),
            Some("GET, POST, DELETE")
        );
        assert_eq!(
            header_value(&response, "access-control-allow-headers").as_deref(),
            Some("authorization, content-type")
        );
    }

    #[test]
    fn cors_origin_header_is_added_to_responses() {
        let response = with_cors(Response::from_data(Vec::new()).boxed());
        assert_eq!(
            header_value(&response, "access-control-allow-origin").as_deref(),
            Some("*")
        );
    }
}
