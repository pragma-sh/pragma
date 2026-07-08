use base64::Engine;
use tiny_http::{Header, Response, StatusCode};

use crate::error::{GatewayError, GatewayResult};
use crate::http::router::RouteMatch;
use crate::http::AppState;

use super::param;

/// Handles `GET /v1/assets/{hash}` — serves a plugin-contributed icon by content
/// hash. The hash is validated as lowercase-hex sha256 and only ever used as a
/// map key by the server (never a path), so there is no traversal surface. The
/// hash is also the strong `ETag`; icons are immutable so the response is
/// aggressively cacheable.
pub fn get(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<Response<std::io::Cursor<Vec<u8>>>> {
    let hash = param(matched, "hash")?;
    if !is_lowercase_hex_sha256(&hash) {
        return Err(GatewayError::NotFound);
    }
    let value = state.client.read_asset(&hash)?;
    let mime = value
        .get("mime")
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    let base64 = value
        .get("base64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GatewayError::Server("asset response missing base64".to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|err| GatewayError::Server(format!("invalid asset base64: {err}")))?;

    let mut response = Response::from_data(bytes).with_status_code(StatusCode(200));
    response.add_header(header("content-type", &mime));
    response.add_header(header("etag", &format!("\"{hash}\"")));
    response.add_header(header(
        "cache-control",
        "public, max-age=31536000, immutable",
    ));
    Ok(response)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn is_lowercase_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::is_lowercase_hex_sha256;

    #[test]
    fn validates_hashes() {
        assert!(is_lowercase_hex_sha256(&"a".repeat(64)));
        assert!(!is_lowercase_hex_sha256(&"A".repeat(64)));
        assert!(!is_lowercase_hex_sha256("../../etc/passwd"));
        assert!(!is_lowercase_hex_sha256("abc"));
    }
}
