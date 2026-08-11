use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use pragma_constants::CONSTANTS;
use serde_json::Value;
use tiny_http::{Header, Request, Response, ResponseBox, StatusCode};

use crate::error::{GatewayError, GatewayResult};
use crate::http::router::RouteMatch;
use crate::http::AppState;
use crate::web::{WebAsset, WebBundle};

// Serves the Pragma Go web bundle under the gateway's web base path.
//
// These are the gateway's only unauthenticated routes besides `/v1/health`, and
// deliberately so: a browser cannot attach a bearer token to the request that
// loads a document or a script. Nothing here is secret — it is the same client
// code that ships in the app bundle — and the token still guards every `/v1`
// route the app then calls.

/// Handles `GET {basePath}` and `GET {basePath}/{*path}`.
pub fn get(state: &AppState, matched: &RouteMatch, request: Request) -> GatewayResult<()> {
    if !web_access_enabled() {
        return respond(
            request,
            error_page(404, "Web access is disabled on this host."),
        );
    }
    let Some(bundle) = state.web.as_ref() else {
        // A gateway built without a staged bundle (a `cargo run`, or a desktop
        // install whose resources are missing) still serves every API route.
        return respond(request, not_available());
    };
    let path = matched.params.get("path").map_or("", String::as_str);
    let Some(asset) = bundle.resolve(path) else {
        return respond(request, error_page(404, "Not found"));
    };
    if is_not_modified(&request, asset) {
        return respond(request, not_modified(asset));
    }
    let accepts_gzip = accepts_gzip(&request);
    respond(request, asset_response(bundle, asset, accepts_gzip)?)
}

/// Whether the global Settings document explicitly permits public web assets.
///
/// This is checked for every request so toggling the setting takes effect without
/// restarting the persistent gateway process.
fn web_access_enabled() -> bool {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return false;
    };
    let path = PathBuf::from(home).join(".pragma/config.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| web_access_enabled_from_config(&contents))
        .unwrap_or(CONSTANTS.gateway.web.enabled)
}

fn web_access_enabled_from_config(contents: &str) -> Option<bool> {
    serde_json::from_str::<Value>(contents)
        .ok()?
        .get("gateway")?
        .get("webEnabled")?
        .as_bool()
}

/// Builds the response body for one asset, decompressing only if it must.
fn asset_response(
    bundle: &WebBundle,
    asset: &WebAsset,
    accepts_gzip: bool,
) -> GatewayResult<ResponseBox> {
    let path = bundle.file_path(asset);
    let file = File::open(&path)?;
    let mut response = if asset.gzip && !accepts_gzip {
        // Text assets are stored gzipped and served that way to every real
        // browser. This is the fallback for a client that says it cannot take
        // gzip: correctness over the memory a streamed file would have saved.
        let mut bytes = Vec::new();
        GzDecoder::new(file).read_to_end(&mut bytes)?;
        Response::from_data(bytes).boxed()
    } else {
        Response::from_file(file).boxed()
    };
    if asset.gzip && accepts_gzip {
        response.add_header(header("content-encoding", "gzip"));
    }
    for (field, value) in asset_headers(asset) {
        response.add_header(header(field, &value));
    }
    Ok(response)
}

/// The headers every representation of an asset carries.
fn asset_headers(asset: &WebAsset) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("content-type", asset.content_type.clone()),
        ("etag", format!("\"{}\"", asset.etag)),
        ("cache-control", cache_control(asset).to_string()),
        // Compressed responses vary by what the client accepted.
        ("vary", "accept-encoding".to_string()),
        ("x-content-type-options", "nosniff".to_string()),
        ("referrer-policy", "no-referrer".to_string()),
    ];
    if asset.content_type.starts_with("text/html") {
        headers.push(("content-security-policy", csp()));
    }
    headers
}

/// Cache policy: content-hashed files are immutable, the entry point is not.
fn cache_control(asset: &WebAsset) -> &'static str {
    if asset.immutable {
        "public, max-age=31536000, immutable"
    } else {
        // The entry point names the hashed bundles, so it must be revalidated
        // or an updated desktop would keep serving the previous app forever.
        "no-cache"
    }
}

/// Content Security Policy for the app document.
///
/// `'unsafe-eval'` is required, not sloppiness: the scratchpad viewer compiles
/// MDX in the browser at run time, which is `new Function` by construction.
/// That content runs in a sandboxed, opaque-origin `<iframe>` (see
/// `ScratchpadWebView.web.tsx`), so it cannot reach this page's storage or its
/// gateway token — the isolation comes from the sandbox, not from the CSP.
///
/// `frame-ancestors 'none'` matters more here than it looks: it stops another
/// site framing a paired session and driving it.
fn csp() -> String {
    [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ]
    .join("; ")
}

/// Whether the client already holds this exact asset.
fn is_not_modified(request: &Request, asset: &WebAsset) -> bool {
    header_value(request, "if-none-match").is_some_and(|value| {
        value
            .split(',')
            .any(|candidate| candidate.trim().trim_matches('"') == asset.etag)
    })
}

fn not_modified(asset: &WebAsset) -> ResponseBox {
    let mut response = Response::from_data(Vec::new())
        .with_status_code(StatusCode(304))
        .boxed();
    for (field, value) in asset_headers(asset) {
        response.add_header(header(field, &value));
    }
    response
}

fn accepts_gzip(request: &Request) -> bool {
    header_value(request, "accept-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("gzip"))
}

fn header_value(request: &Request, field: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(field))
        .map(|header| header.value.as_str().to_string())
}

/// The response for a gateway that has no bundle staged.
fn not_available() -> ResponseBox {
    error_page(
        503,
        "The web app is not installed on this host. Open Pragma on the desktop instead.",
    )
}

/// A plain-text error, so a browser shows the reason rather than a blank page.
fn error_page(status: u16, message: &str) -> ResponseBox {
    let mut response = Response::from_string(message)
        .with_status_code(StatusCode(status))
        .boxed();
    response.add_header(header("content-type", "text/plain; charset=utf-8"));
    response.add_header(header("cache-control", "no-store"));
    response
}

fn respond(request: Request, response: ResponseBox) -> GatewayResult<()> {
    request
        .respond(response)
        .map_err(|error| GatewayError::Http(error.to_string()))
}

fn header(field: &str, value: &str) -> Header {
    Header::from_bytes(field.as_bytes(), value.as_bytes()).expect("valid header")
}

#[cfg(test)]
mod tests {
    use super::{cache_control, csp, web_access_enabled_from_config};
    use crate::web::WebAsset;

    fn asset(immutable: bool, content_type: &str) -> WebAsset {
        WebAsset {
            path: "index.html".to_string(),
            file: "index.html".to_string(),
            content_type: content_type.to_string(),
            gzip: true,
            etag: "abc".to_string(),
            immutable,
        }
    }

    #[test]
    fn hashed_assets_cache_forever_and_the_entry_point_does_not() {
        assert!(cache_control(&asset(true, "text/javascript")).contains("immutable"));
        assert_eq!(cache_control(&asset(false, "text/html")), "no-cache");
    }

    #[test]
    fn csp_denies_framing_and_allows_the_mdx_runtime() {
        let policy = csp();
        assert!(policy.contains("frame-ancestors 'none'"));
        // The scratchpad viewer compiles MDX in-page; without this it cannot run.
        assert!(policy.contains("'unsafe-eval'"));
    }

    #[test]
    fn web_access_requires_an_explicit_global_setting() {
        assert_eq!(web_access_enabled_from_config("{}"), None);
        assert_eq!(
            web_access_enabled_from_config(r#"{"gateway":{"webEnabled":false}}"#),
            Some(false)
        );
        assert_eq!(
            web_access_enabled_from_config(r#"{"gateway":{"webEnabled":true}}"#),
            Some(true)
        );
    }
}
