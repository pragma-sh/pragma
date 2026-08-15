use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Duration;

use pragma_constants::{AgentCatalog, WorkspaceSnapshot, CONSTANTS};
use reqwest::blocking::{Client, RequestBuilder};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::events::VerifyEvent;

/// Session identity returned by `agentSessionLaunch`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchResult {
    pub worktree_id: String,
    pub tab_id: String,
}

/// Inputs for one `agentSessionLaunch` request.
pub struct LaunchSpec<'a> {
    pub project_id: &'a str,
    pub worktree_id: &'a str,
    pub agent_id: &'a str,
    pub model_id: Option<&'a str>,
    /// Raw model command overriding `model_id` at launch.
    pub model_cmd: Option<&'a str>,
    /// Launch server-side without opening a desktop tab.
    pub headless: bool,
    pub prompt: &'a str,
}

/// Gateway operations used by verification scenarios.
pub trait VerifyApi: Send + Sync {
    fn catalog(&self) -> Result<AgentCatalog, String>;
    fn asset_exists(&self, hash: &str) -> Result<(), String>;
    fn workspace_snapshot(&self) -> Result<WorkspaceSnapshot, String>;
    fn launch(&self, spec: &LaunchSpec<'_>) -> Result<LaunchResult, String>;
    fn clear_status(&self, agent: &str, worktree_id: &str, tab_id: &str) -> Result<(), String>;
    fn answer(
        &self,
        agent: &str,
        worktree_id: &str,
        tab_id: &str,
        request_id: &str,
        answer: Option<&str>,
    ) -> Result<(), String>;
    fn decide(
        &self,
        agent: &str,
        worktree_id: &str,
        tab_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), String>;
    fn interrupt(&self, agent: &str, worktree_id: &str, tab_id: &str) -> Result<(), String>;
    fn input(&self, agent: &str, worktree_id: &str, tab_id: &str, text: &str)
        -> Result<(), String>;
    fn write_input(&self, session_id: &str, bytes: &[u8]) -> Result<(), String>;
    fn kill_session(&self, session_id: &str) -> Result<(), String>;
    fn usage_limits(&self, plugin_id: &str) -> Result<Value, String>;
    fn event_reader(&self) -> Result<Box<dyn BufRead + Send>, String>;
}

/// Blocking HTTP client for the local authenticated gateway.
pub struct HttpVerifyApi {
    base_url: String,
    token: String,
    client: Client,
}

impl HttpVerifyApi {
    /// Resolves gateway credentials from env or discovery beside daemon socket.
    pub fn discover() -> Result<Self, String> {
        let credentials = match std::env::var("PRAGMA_GATEWAY_URL") {
            Ok(url) if !url.trim().is_empty() => {
                let token = std::env::var("PRAGMA_GATEWAY_TOKEN")
                    .map_err(|_| "PRAGMA_GATEWAY_TOKEN is required with PRAGMA_GATEWAY_URL")?;
                (url, token)
            }
            _ => discovery_credentials()?,
        };
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| format!("build gateway client: {error}"))?;
        Ok(Self {
            base_url: credentials.0.trim_end_matches('/').to_string(),
            token: credentials.1,
            client,
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.base_url))
            .bearer_auth(&self.token)
    }

    fn send(request: RequestBuilder) -> Result<reqwest::blocking::Response, String> {
        let response = request
            .send()
            .map_err(|error| format!("gateway request failed: {error}"))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = response.text().unwrap_or_default();
        Err(format!("gateway returned {status}: {body}"))
    }

    fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        Self::send(self.request(reqwest::Method::GET, path))?
            .json()
            .map_err(|error| format!("decode gateway response: {error}"))
    }

    fn post_json<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T, String> {
        Self::send(self.request(reqwest::Method::POST, path).json(body))?
            .json()
            .map_err(|error| format!("decode gateway response: {error}"))
    }

    fn post_empty(&self, path: &str, body: &Value) -> Result<(), String> {
        Self::send(self.request(reqwest::Method::POST, path).json(body))?;
        Ok(())
    }
}

impl VerifyApi for HttpVerifyApi {
    fn catalog(&self) -> Result<AgentCatalog, String> {
        self.get_json("/v1/agents/catalog")
    }

    fn asset_exists(&self, hash: &str) -> Result<(), String> {
        Self::send(self.request(reqwest::Method::GET, &format!("/v1/assets/{hash}")))?;
        Ok(())
    }

    fn workspace_snapshot(&self) -> Result<WorkspaceSnapshot, String> {
        let response = Self::send(
            self.request(reqwest::Method::GET, "/v1/subscriptions/workspace")
                .timeout(Duration::from_secs(10)),
        )?;
        for line in BufReader::new(response).lines() {
            let line = line.map_err(|error| format!("read workspace stream: {error}"))?;
            match serde_json::from_str::<VerifyEvent>(&line) {
                Ok(VerifyEvent::Snapshot { payload, .. }) => {
                    return serde_json::from_value(payload)
                        .map_err(|error| format!("decode workspace snapshot: {error}"));
                }
                Ok(_) => {}
                Err(error) => return Err(format!("invalid workspace event: {error}: {line}")),
            }
        }
        Err("workspace stream ended before snapshot".to_string())
    }

    fn launch(&self, spec: &LaunchSpec<'_>) -> Result<LaunchResult, String> {
        let mut body = json!({
            "projectId": spec.project_id,
            "worktreeId": spec.worktree_id,
            "newWorktree": null,
            "agentId": spec.agent_id,
            "modelId": spec.model_id,
            "reasoningId": null,
            "modelCmd": spec.model_cmd,
            "prompt": spec.prompt,
        });
        // Only sent when requested so headed launches keep the exact payload the
        // desktop broker has always received.
        if spec.headless {
            body["headless"] = json!(true);
        }
        self.post_json("/v1/control/agentSessionLaunch", &body)
    }

    fn clear_status(&self, agent: &str, worktree_id: &str, tab_id: &str) -> Result<(), String> {
        self.post_empty(
            "/v1/agents/reports",
            &json!({
                "agent": agent,
                "worktreeId": worktree_id,
                "tabId": tab_id,
                "status": "cleared",
            }),
        )
    }

    fn answer(
        &self,
        agent: &str,
        worktree_id: &str,
        tab_id: &str,
        request_id: &str,
        answer: Option<&str>,
    ) -> Result<(), String> {
        self.post_empty(
            "/v1/agents/answers",
            &json!({
                "agent": agent,
                "worktreeId": worktree_id,
                "tabId": tab_id,
                "requestId": request_id,
                "answer": answer,
                "dismissed": answer.is_none(),
            }),
        )
    }

    fn decide(
        &self,
        agent: &str,
        worktree_id: &str,
        tab_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        self.post_empty(
            "/v1/agents/decisions",
            &json!({
                "agent": agent,
                "worktreeId": worktree_id,
                "tabId": tab_id,
                "requestId": request_id,
                "approved": approved,
            }),
        )
    }

    fn interrupt(&self, agent: &str, worktree_id: &str, tab_id: &str) -> Result<(), String> {
        self.post_empty(
            "/v1/agents/interrupts",
            &json!({ "agent": agent, "worktreeId": worktree_id, "tabId": tab_id }),
        )
    }

    fn input(
        &self,
        agent: &str,
        worktree_id: &str,
        tab_id: &str,
        text: &str,
    ) -> Result<(), String> {
        self.post_empty(
            "/v1/agents/inputs",
            &json!({
                "agent": agent,
                "worktreeId": worktree_id,
                "tabId": tab_id,
                "text": text,
            }),
        )
    }

    fn write_input(&self, session_id: &str, bytes: &[u8]) -> Result<(), String> {
        Self::send(
            self.request(
                reqwest::Method::POST,
                &format!("/v1/sessions/{session_id}/input"),
            )
            .header("content-type", "application/octet-stream")
            .body(bytes.to_vec()),
        )?;
        Ok(())
    }

    fn kill_session(&self, session_id: &str) -> Result<(), String> {
        Self::send(self.request(
            reqwest::Method::DELETE,
            &format!("/v1/sessions/{session_id}"),
        ))?;
        Ok(())
    }

    fn usage_limits(&self, plugin_id: &str) -> Result<Value, String> {
        self.post_json(
            "/v1/rpc/plugins",
            &json!({ "action": "usageLimits", "pluginId": plugin_id }),
        )
    }

    fn event_reader(&self) -> Result<Box<dyn BufRead + Send>, String> {
        let response = Self::send(self.request(reqwest::Method::GET, "/v1/agents/events"))?;
        Ok(Box::new(BufReader::new(response)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayDiscovery {
    port: u16,
    token: String,
}

fn discovery_credentials() -> Result<(String, String), String> {
    let socket = crate::server::socket_path()?;
    let path = Path::new(&socket).with_file_name(CONSTANTS.gateway.discovery_file.as_str());
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("read gateway discovery {}: {error}", path.display()))?;
    let discovery: GatewayDiscovery = serde_json::from_str(&contents)
        .map_err(|error| format!("decode gateway discovery {}: {error}", path.display()))?;
    if discovery.port == 0 || discovery.token.is_empty() {
        return Err(format!(
            "gateway discovery is incomplete: {}",
            path.display()
        ));
    }
    Ok((
        format!("http://127.0.0.1:{}", discovery.port),
        discovery.token,
    ))
}
