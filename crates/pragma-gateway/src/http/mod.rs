use pragma_platform::ipc::LocalStream;
pub mod response;
pub mod router;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Method, Request, Response, ResponseBox, Server, StatusCode};

use crate::auth::verify_bearer;
use crate::client::GatewayClient;
use crate::devices::DeviceRegistry;
use crate::error::{GatewayError, GatewayResult};
use crate::http::response::error_response;
use crate::push::{DesktopPresence, PushWorker};
use crate::routes;
use crate::web::WebBundle;

use self::router::gateway_router;

/// Spawn event streams held until the client opens the real events endpoint.
pub type PendingSpawnStreams = Arc<Mutex<HashMap<String, LocalStream>>>;

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
    /// Authenticated mobile device history.
    pub devices: Arc<Mutex<DeviceRegistry>>,
    /// Expo push delivery, absent when no HTTP client could be built.
    pub push: Option<PushWorker>,
    /// Last reported desktop window focus, which gates phone pushes.
    pub presence: DesktopPresence,
    /// The staged Pragma Go web bundle, absent when none is installed.
    pub web: Option<Arc<WebBundle>>,
}

/// Routes served without a bearer token.
///
/// `health` is the liveness probe a client calls before it has credentials.
/// The web routes serve the browser client's own HTML and JavaScript, which a
/// browser cannot authenticate: a `<script src>` carries no `authorization`
/// header. Both are public code and public status; every route that touches a
/// project stays behind the token.
fn is_public(route_id: &str) -> bool {
    matches!(route_id, "health" | "web.asset")
}

/// Runs the blocking `tiny_http` accept loop.
pub fn serve(server: &Server, state: &AppState) {
    let state = Arc::new(state.clone());
    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        thread::spawn(move || respond(request, &state));
    }
}

fn respond(request: Request, state: &AppState) {
    if *request.method() == Method::Options {
        let _ = request.respond(with_cors(preflight_response()));
        return;
    }
    if let Err(error) = dispatch(request, state) {
        eprintln!("gateway dispatch error: {error}");
    }
}

/// Answers a CORS preflight so webview clients (`tauri://localhost` in release
/// builds, `http://localhost:*` in dev) can call the gateway with the
/// `authorization` and `content-type` headers the SDK sends. Authentication
/// stays with the bearer token; the origin itself carries no trust.
fn preflight_response() -> ResponseBox {
    let mut response = Response::from_data(Vec::new()).with_status_code(StatusCode(204));
    response.add_header(header("access-control-allow-methods", "GET, POST, DELETE"));
    response.add_header(header("access-control-allow-headers", &allowed_headers()));
    response.add_header(header("access-control-max-age", "86400"));
    response.boxed()
}

fn allowed_headers() -> String {
    let gateway = &pragma_constants::CONSTANTS.gateway;
    format!(
        "{}, content-type, {}, {}, {}, {}",
        gateway.token_header,
        gateway.device_headers.id,
        gateway.device_headers.name,
        gateway.device_headers.platform,
        gateway.device_headers.app_version,
    )
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

fn dispatch(request: Request, state: &AppState) -> GatewayResult<()> {
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let matched = gateway_router()
        .match_route(&method, &url)
        .ok_or(GatewayError::NotFound)?;

    if !is_public(matched.id) && !authorized(&request, &state.token) {
        request.respond(with_cors(
            error_response(&GatewayError::Unauthorized).boxed(),
        ))?;
        return Ok(());
    }
    if !is_public(matched.id) {
        if let Ok(devices) = state.devices.lock() {
            if let Err(error) = devices.record(&request) {
                eprintln!("gateway device registry error: {error}");
            }
        }
    }

    match matched.id {
        "health" => respond_json(request, routes::health::health(state)),
        "version" => respond_json(request, routes::health::version(state)),
        "rpc" => {
            let mut req = request;
            let result = routes::rpc::rpc(&mut req, state, &matched);
            respond_json(req, result)
        }
        "sessions.spawn" => {
            let mut req = request;
            let result = routes::sessions::spawn(&mut req, state);
            respond_json(req, result)
        }
        "sessions.events" => routes::sessions::events(request, state, &matched),
        "sessions.input" => {
            let mut req = request;
            let result = routes::sessions::input(&mut req, state, &matched);
            respond_json(req, result)
        }
        "sessions.resize" => {
            let mut req = request;
            let result = routes::sessions::resize(&mut req, state, &matched);
            respond_json(req, result)
        }
        "sessions.kill" => respond_json(request, routes::sessions::kill(state, &matched)),
        "sessions.killForCwd" => {
            respond_json(request, routes::sessions::kill_for_cwd(state, &matched))
        }
        "agents.reports" => {
            let mut req = request;
            let result = routes::agents::report(&mut req, state);
            respond_json(req, result)
        }
        "agents.messages" => {
            let mut req = request;
            let result = routes::agents::message(&mut req, state);
            respond_json(req, result)
        }
        "agents.decisions" => {
            let mut req = request;
            let result = routes::agents::decision(&mut req, state);
            respond_json(req, result)
        }
        "agents.answers" => {
            let mut req = request;
            let result = routes::agents::answer(&mut req, state);
            respond_json(req, result)
        }
        "agents.inputs" => {
            let mut req = request;
            let result = routes::agents::input(&mut req, state);
            respond_json(req, result)
        }
        "agents.interrupts" => {
            let mut req = request;
            let result = routes::agents::interrupt(&mut req, state);
            respond_json(req, result)
        }
        "agents.catalog" => respond_json(request, routes::agents::catalog(state)),
        "agents.events" => routes::agents::events(request, state),
        "assets.get" => respond_json(request, routes::assets::get(state, &matched)),
        "theme.get" => respond_json(request, routes::theme::get(state, &matched)),
        "scratchpads.list" => respond_json(request, routes::scratchpads::list(state, &matched)),
        "control" => {
            let mut req = request;
            let result = routes::control::control(&mut req, state, &matched);
            respond_json(req, result)
        }
        "agents.seen" => respond_json(request, routes::agents::mark_seen(state, &matched)),
        "web.asset" => routes::web::get(state, &matched, request),
        "subscriptions.events" => routes::subscriptions::events(request, state, &matched),
        id if id.starts_with("push.") => routes::push::dispatch(request, state, id),
        _ => Ok(request.respond(with_cors(error_response(&GatewayError::NotFound).boxed()))?),
    }
}

/// Sends a route's outcome to the client: the successful response, or the
/// error as a JSON `ErrorBody` with the error's HTTP status. Route failures
/// must never drop the request — a dropped `tiny_http` request turns into an
/// empty 500 the SDK cannot explain to the user.
pub(crate) fn respond_json(
    request: Request,
    result: GatewayResult<Response<std::io::Cursor<Vec<u8>>>>,
) -> GatewayResult<()> {
    match result {
        Ok(response) => Ok(request.respond(with_cors(response.boxed()))?),
        Err(error) => {
            if !matches!(error, GatewayError::NotFound | GatewayError::Conflict(_)) {
                eprintln!("gateway route error: {error}");
            }
            Ok(request.respond(with_cors(error_response(&error).boxed()))?)
        }
    }
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

    use super::{allowed_headers, preflight_response, with_cors};

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
        let expected_headers = allowed_headers();
        assert_eq!(response.status_code().0, 204);
        assert_eq!(
            header_value(&response, "access-control-allow-methods").as_deref(),
            Some("GET, POST, DELETE")
        );
        assert_eq!(
            header_value(&response, "access-control-allow-headers").as_deref(),
            Some(expected_headers.as_str())
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
