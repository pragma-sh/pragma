//! Delivery to Expo's push service.

use std::time::Duration;

use pragma_constants::CONSTANTS;
use serde::Serialize;
use serde_json::Value;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One notification, addressed to a single Expo push token.
#[derive(Clone, Debug, Serialize)]
pub struct PushMessage {
    pub to: String,
    pub title: String,
    pub body: String,
    /// Routing payload the phone reads on tap: `projectId`, `worktreeId`, `tabId`.
    pub data: Value,
    pub sound: &'static str,
}

/// Whether a push token could ever have come from Expo. Rejecting a malformed
/// token at registration keeps a typo from looking like a delivery failure much
/// later, when there is nothing left to correlate it with.
#[must_use]
pub fn is_expo_token(token: &str) -> bool {
    CONSTANTS
        .gateway
        .push
        .token_prefixes
        .iter()
        .any(|prefix| token.starts_with(prefix.as_str()))
        && token.ends_with(']')
        && token.len() <= 256
}

/// What Expo made of one batch of messages.
///
/// A per-message rejection is not a transport failure — the rest of the batch
/// still went out — but it is the only place the reason a platform refuses
/// delivery ever appears. An APNs key that was never uploaded for the project,
/// for instance, shows up here as `InvalidCredentials` on every iOS ticket and
/// nowhere else, so the rejections are carried back to the caller rather than
/// dropped.
#[derive(Debug, Default)]
pub struct SendOutcome {
    /// Tokens whose device is permanently gone, for the caller to forget.
    pub dead: Vec<String>,
    /// One human-readable line per rejected message.
    pub errors: Vec<String>,
}

/// Sends messages to Expo in batches, reporting the dead tokens and the
/// per-message rejections. Transport failures are reported as errors.
pub fn send(
    client: &reqwest::blocking::Client,
    messages: &[PushMessage],
) -> Result<SendOutcome, String> {
    let push = &CONSTANTS.gateway.push;
    let batch_size = usize::try_from(push.batch_size.get()).unwrap_or(usize::MAX);
    let mut outcome = SendOutcome::default();
    for batch in messages.chunks(batch_size) {
        let response = client
            .post(push.send_url.as_str())
            .timeout(REQUEST_TIMEOUT)
            .json(&batch)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("expo push responded {}", response.status()));
        }
        let body: Value = response.json().map_err(|error| error.to_string())?;
        let batch_outcome = read_tickets(&body, batch);
        outcome.dead.extend(batch_outcome.dead);
        outcome.errors.extend(batch_outcome.errors);
    }
    Ok(outcome)
}

/// Reads Expo's per-message tickets, which are returned in request order.
fn read_tickets(body: &Value, batch: &[PushMessage]) -> SendOutcome {
    let Some(tickets) = body.get("data").and_then(Value::as_array) else {
        return SendOutcome::default();
    };
    let mut outcome = SendOutcome::default();
    for (ticket, message) in tickets.iter().zip(batch) {
        if ticket.get("status").and_then(Value::as_str) != Some("error") {
            continue;
        }
        let code = ticket
            .get("details")
            .and_then(|details| details.get("error"))
            .and_then(Value::as_str);
        if code == Some("DeviceNotRegistered") {
            outcome.dead.push(message.to.clone());
        }
        outcome.errors.push(ticket_error(ticket, code));
    }
    outcome
}

/// One rejection, as a line worth showing a person: the error code Expo names
/// (`InvalidCredentials`, `MessageRateExceeded`, …) plus its explanation.
fn ticket_error(ticket: &Value, code: Option<&str>) -> String {
    let message = ticket
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("expo rejected the message");
    match code {
        Some(code) => format!("{code}: {message}"),
        None => message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_expo_token, read_tickets, PushMessage};
    use serde_json::json;

    fn message(to: &str) -> PushMessage {
        PushMessage {
            to: to.to_string(),
            title: "title".to_string(),
            body: "body".to_string(),
            data: json!({}),
            sound: "default",
        }
    }

    #[test]
    fn accepts_only_expo_shaped_tokens() {
        assert!(is_expo_token("ExponentPushToken[abc123]"));
        assert!(is_expo_token("ExpoPushToken[abc123]"));
        assert!(!is_expo_token("abc123"));
        assert!(!is_expo_token("ExponentPushToken[abc123"));
    }

    #[test]
    fn collects_only_permanently_dead_tokens() {
        let batch = [message("token-a"), message("token-b"), message("token-c")];
        let body = json!({
            "data": [
                { "status": "ok" },
                { "status": "error", "details": { "error": "DeviceNotRegistered" } },
                { "status": "error", "details": { "error": "MessageRateExceeded" } },
            ]
        });

        assert_eq!(
            read_tickets(&body, &batch).dead,
            vec!["token-b".to_string()]
        );
    }

    #[test]
    fn reports_every_rejection_with_its_reason() {
        let batch = [message("token-a"), message("token-b")];
        let body = json!({
            "data": [
                { "status": "ok" },
                {
                    "status": "error",
                    "message": "the recipient is not a valid Expo push token",
                    "details": { "error": "InvalidCredentials" },
                },
            ]
        });

        assert_eq!(
            read_tickets(&body, &batch).errors,
            vec!["InvalidCredentials: the recipient is not a valid Expo push token".to_string()]
        );
    }

    #[test]
    fn tolerates_a_response_without_tickets() {
        let outcome = read_tickets(&json!({}), &[message("token-a")]);
        assert!(outcome.dead.is_empty());
        assert!(outcome.errors.is_empty());
    }
}
