use std::collections::HashMap;

/// Matched route with extracted path params and query params.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RouteMatch {
    /// Route id chosen by the gateway dispatcher.
    pub id: &'static str,
    /// Path parameters extracted from `{param}` segments.
    pub params: HashMap<String, String>,
    /// Query parameters from the request URL.
    pub query: HashMap<String, String>,
}

/// Small method/path router with `{param}` extraction.
#[derive(Default)]
pub struct Router {
    routes: Vec<Route>,
}

struct Route {
    method: &'static str,
    pattern: &'static str,
    id: &'static str,
}

impl Router {
    /// Creates an empty router.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a route.
    #[must_use]
    pub fn route(mut self, method: &'static str, pattern: &'static str, id: &'static str) -> Self {
        self.routes.push(Route {
            method,
            pattern,
            id,
        });
        self
    }

    /// Matches a method and URL.
    #[must_use]
    pub fn match_route(&self, method: &str, url: &str) -> Option<RouteMatch> {
        let (path, query) = split_url(url);
        self.routes.iter().find_map(|route| {
            if route.method != method {
                return None;
            }
            match_pattern(route.pattern, path).map(|params| RouteMatch {
                id: route.id,
                params,
                query: parse_query(query),
            })
        })
    }
}

/// Builds the gateway route table.
#[must_use]
pub fn gateway_router() -> Router {
    Router::new()
        .route("GET", "/v1/health", "health")
        .route("GET", "/v1/version", "version")
        .route("POST", "/v1/rpc/{method}", "rpc")
        .route("POST", "/v1/sessions", "sessions.spawn")
        .route("GET", "/v1/sessions/{id}/events", "sessions.events")
        .route("POST", "/v1/sessions/{id}/input", "sessions.input")
        .route("POST", "/v1/sessions/{id}/resize", "sessions.resize")
        .route("DELETE", "/v1/sessions/{id}", "sessions.kill")
        .route("DELETE", "/v1/sessions", "sessions.killForCwd")
        .route("POST", "/v1/agents/reports", "agents.reports")
        .route("POST", "/v1/agents/messages", "agents.messages")
        .route("POST", "/v1/agents/decisions", "agents.decisions")
        .route("POST", "/v1/agents/answers", "agents.answers")
        .route("POST", "/v1/agents/inputs", "agents.inputs")
        .route("POST", "/v1/agents/interrupts", "agents.interrupts")
        .route("GET", "/v1/agents/catalog", "agents.catalog")
        .route("GET", "/v1/agents/events", "agents.events")
        .route("POST", "/v1/control/{method}", "control")
        .route("GET", "/v1/assets/{hash}", "assets.get")
        .route("GET", "/v1/theme", "theme.get")
        .route("GET", "/v1/scratchpads", "scratchpads.list")
        .route("POST", "/v1/tabs/{tabId}/agents/seen", "agents.seen")
        .route("GET", "/v1/subscriptions/{event}", "subscriptions.events")
        .route("POST", "/v1/push/tokens", "push.register")
        .route("DELETE", "/v1/push/tokens", "push.unregister")
        .route("GET", "/v1/push/tokens", "push.list")
        .route("POST", "/v1/push/test", "push.test")
        .route("POST", "/v1/push/presence", "push.presence")
        // The Pragma Go web bundle. A catch-all because the app is a
        // single-page bundle: every unknown sub-path under it is a client
        // route that resolves to `index.html`, not a missing file. The
        // wildcard also matches the bare base path with an empty remainder,
        // so `/web` needs no route of its own. The literal must match
        // `CONSTANTS.gateway.web.base_path` — a route pattern has to be a
        // `&'static str`, so `base_path_matches_constant` guards the pair.
        .route("GET", "/web/{*path}", "web.asset")
}

fn split_url(url: &str) -> (&str, &str) {
    url.split_once('?')
        .map_or((url, ""), |(path, query)| (path, query))
}

fn match_pattern(pattern: &str, path: &str) -> Option<HashMap<String, String>> {
    let pattern_parts: Vec<&str> = pattern.trim_matches('/').split('/').collect();
    let path_parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    // A trailing `{*name}` swallows the rest of the path, so it matches any
    // length at or beyond its own position. Static routes stay exact-length.
    let wildcard = pattern_parts
        .last()
        .and_then(|part| wildcard_name(part))
        .map(|name| (pattern_parts.len() - 1, name));
    match wildcard {
        Some((prefix_len, _)) if path_parts.len() < prefix_len => return None,
        None if pattern_parts.len() != path_parts.len() => return None,
        _ => {}
    }

    let mut params = HashMap::new();
    let fixed_len = wildcard.map_or(pattern_parts.len(), |(prefix_len, _)| prefix_len);
    for (pattern, actual) in pattern_parts.iter().zip(path_parts.iter()).take(fixed_len) {
        if let Some(name) = pattern
            .strip_prefix('{')
            .and_then(|part| part.strip_suffix('}'))
        {
            params.insert(name.to_string(), percent_decode(actual));
        } else if pattern != actual {
            return None;
        }
    }
    if let Some((prefix_len, name)) = wildcard {
        // Segments are decoded then rejoined, so an encoded `/` does become a
        // separator here. That is safe only because the value is used as a
        // lookup key into a manifest of real assets, never joined onto a
        // filesystem path — see `routes::web`.
        let rest = path_parts[prefix_len..]
            .iter()
            .map(|part| percent_decode(part))
            .collect::<Vec<_>>()
            .join("/");
        params.insert(name.to_string(), rest);
    }
    Some(params)
}

/// The parameter name of a `{*name}` catch-all segment, if this is one.
fn wildcard_name(part: &str) -> Option<&str> {
    part.strip_prefix("{*")
        .and_then(|rest| rest.strip_suffix('}'))
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    out.push((high << 4) | low);
                    index += 3;
                    continue;
                }
                out.push(bytes[index]);
            }
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::gateway_router;

    #[test]
    fn matches_path_params_and_query() {
        let matched = gateway_router()
            .match_route("GET", "/v1/sessions/tab%201/events?cwd=%2Frepo")
            .expect("route");
        assert_eq!(matched.id, "sessions.events");
        assert_eq!(matched.params.get("id").map(String::as_str), Some("tab 1"));
        assert_eq!(matched.query.get("cwd").map(String::as_str), Some("/repo"));
    }

    #[test]
    fn rejects_unknown_routes() {
        assert!(gateway_router().match_route("GET", "/missing").is_none());
    }

    #[test]
    fn base_path_matches_constant() {
        // The router patterns spell the base path literally because they must be
        // `&'static str`. If the constant ever moves, these must move with it.
        assert_eq!(pragma_constants::CONSTANTS.gateway.web.base_path, "/web");
    }

    #[test]
    fn catch_all_collects_the_remaining_path() {
        let router = gateway_router();
        let matched = router
            .match_route("GET", "/web/_expo/static/js/web/entry-abc.js")
            .expect("route");
        assert_eq!(matched.id, "web.asset");
        assert_eq!(
            matched.params.get("path").map(String::as_str),
            Some("_expo/static/js/web/entry-abc.js")
        );
    }

    #[test]
    fn catch_all_matches_its_own_prefix() {
        // `/web` itself is the app's entry point, not a miss.
        let matched = gateway_router().match_route("GET", "/web").expect("route");
        assert_eq!(matched.id, "web.asset");
        assert_eq!(matched.params.get("path").map(String::as_str), Some(""));
    }

    #[test]
    fn catch_all_decodes_each_segment_separately() {
        // Documents the decode-then-join behaviour: `%2F` reaches the handler as
        // a separator, which is harmless because the value only ever indexes the
        // asset manifest.
        let matched = gateway_router()
            .match_route("GET", "/web/a%2Fb/c")
            .expect("route");
        assert_eq!(
            matched.params.get("path").map(String::as_str),
            Some("a/b/c")
        );
    }
}
