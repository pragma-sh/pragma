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

/// Sends messages to Expo in batches and returns the tokens Expo says are dead,
/// so the caller can drop them. Transport failures are reported as errors; a
/// per-message rejection is not, because the rest of the batch still went out.
pub fn send(
    client: &reqwest::blocking::Client,
    messages: &[PushMessage],
) -> Result<Vec<String>, String> {
    let push = &CONSTANTS.gateway.push;
    let batch_size = usize::try_from(push.batch_size.get()).unwrap_or(usize::MAX);
    let mut dead = Vec::new();
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
        dead.extend(dead_tokens(&body, batch));
    }
    Ok(dead)
}

/// Reads Expo's per-message tickets, which are returned in request order, and
/// collects the tokens whose device is permanently gone.
fn dead_tokens(body: &Value, batch: &[PushMessage]) -> Vec<String> {
    let Some(tickets) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    tickets
        .iter()
        .zip(batch)
        .filter(|(ticket, _)| {
            ticket
                .get("details")
                .and_then(|details| details.get("error"))
                .and_then(Value::as_str)
                == Some("DeviceNotRegistered")
        })
        .map(|(_, message)| message.to.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{dead_tokens, is_expo_token, PushMessage};
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

        assert_eq!(dead_tokens(&body, &batch), vec!["token-b".to_string()]);
    }

    #[test]
    fn tolerates_a_response_without_tickets() {
        assert!(dead_tokens(&json!({}), &[message("token-a")]).is_empty());
    }
}
