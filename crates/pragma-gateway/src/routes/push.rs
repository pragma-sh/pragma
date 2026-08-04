use serde::Deserialize;
use serde_json::json;
use tiny_http::Request;

use crate::devices;
use crate::error::{GatewayError, GatewayResult};
use crate::http::response::{empty_response, json_response};
use crate::http::{read_json, respond_json, AppState};
use crate::push::expo::is_expo_token;

type JsonResponse = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

#[derive(Debug, Deserialize)]
struct RegisterBody {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceBody {
    focused: bool,
}

/// Routes every `/v1/push/*` request, keeping the push surface in one place.
pub fn dispatch(request: Request, state: &AppState, id: &str) -> GatewayResult<()> {
    match id {
        "push.list" => respond_json(request, list(state)),
        "push.test" => respond_json(request, test(state)),
        _ => {
            let mut request = request;
            let result = match id {
                "push.register" => register(&mut request, state),
                "push.unregister" => unregister(&mut request, state),
                "push.presence" => presence(&mut request, state),
                _ => Err(GatewayError::NotFound),
            };
            respond_json(request, result)
        }
    }
}

/// Handles `POST /v1/push/tokens`: registers this installation's Expo token.
fn register(request: &mut Request, state: &AppState) -> GatewayResult<JsonResponse> {
    let device_id = device_id(request)?;
    let body: RegisterBody = read_json(request)?;
    let token = body.token.trim().to_string();
    if !is_expo_token(&token) {
        return Err(GatewayError::InvalidPayload(
            "token is not an Expo push token".to_string(),
        ));
    }
    let devices = state.devices.lock().map_err(lock_poisoned)?;
    devices.set_push_token(&device_id, &token)?;
    Ok(empty_response(204))
}

/// Handles `DELETE /v1/push/tokens`: stops push delivery to this installation.
fn unregister(request: &mut Request, state: &AppState) -> GatewayResult<JsonResponse> {
    let device_id = device_id(request)?;
    let devices = state.devices.lock().map_err(lock_poisoned)?;
    devices.clear_push_token(&device_id)?;
    Ok(empty_response(204))
}

/// Handles `GET /v1/push/tokens`: lists phones registered for push.
fn list(state: &AppState) -> GatewayResult<JsonResponse> {
    let devices = state.devices.lock().map_err(lock_poisoned)?;
    let registrations: Vec<_> = devices
        .list()
        .into_iter()
        .filter(|device| device.push_token.is_some())
        .map(|device| {
            json!({
                "deviceId": device.id,
                "name": device.name,
                "platform": device.platform,
                "pushToken": device.push_token,
                "registeredAt": device.push_registered_at,
            })
        })
        .collect();
    json_response(200, &registrations)
}

/// Handles `POST /v1/push/test`: sends a test notification to every phone.
fn test(state: &AppState) -> GatewayResult<JsonResponse> {
    let Some(worker) = state.push.as_ref() else {
        return Err(GatewayError::Http(
            "push delivery is unavailable in this gateway".to_string(),
        ));
    };
    let sent = worker
        .notify_all(
            "Pragma notifications are on",
            "Agent alerts from this host will show up here.",
            &json!({}),
        )
        .map_err(GatewayError::Http)?;
    json_response(202, &json!({ "sent": sent }))
}

/// Handles `POST /v1/push/presence`: records desktop window focus, which
/// suppresses phone pushes while the user is demonstrably at the desktop.
fn presence(request: &mut Request, state: &AppState) -> GatewayResult<JsonResponse> {
    let body: PresenceBody = read_json(request)?;
    state.presence.record(body.focused);
    Ok(empty_response(204))
}

/// Push registration is per installation, so a request without the device-id
/// header has nothing to register against.
fn device_id(request: &Request) -> GatewayResult<String> {
    devices::device_id(request).ok_or_else(|| {
        GatewayError::InvalidPayload(format!(
            "{} header is required to manage push tokens",
            pragma_constants::CONSTANTS.gateway.device_headers.id
        ))
    })
}

fn lock_poisoned<T>(_: T) -> GatewayError {
    GatewayError::Http("device registry lock poisoned".to_string())
}
