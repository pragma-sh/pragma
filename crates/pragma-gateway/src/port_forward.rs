//! Verified HTTP port forwarding with an injected browser design-mode runtime.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{ControlMethod, PortForwardRequest, PortForwardResult, ProtocolRpcMethod};
use reqwest::blocking::Client as HttpClient;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{json, Value};
use tiny_http::{Header, Request, Response, ResponseBox, Server, StatusCode};
use uuid::Uuid;

use crate::client::GatewayClient;
use crate::error::{ErrorBody, GatewayError, GatewayResult};

const MAX_PROXY_BODY_BYTES: u64 = 32 * 1024 * 1024;
/// How long a successful ownership check covers later requests. Checking means
/// scanning the host's whole process and socket tables, and a page load fires
/// dozens of requests at once; re-checking each one queued them behind the
/// server. The cost is a short window in which a listener that has just left
/// its terminal is still reachable.
const PORT_VERIFY_TTL: Duration = Duration::from_secs(5);

/// Live forwarded pages, keyed by the terminal listener they expose.
#[derive(Clone, Default)]
pub struct PortForwardRegistry {
    sessions: Arc<Mutex<HashMap<String, ForwardSession>>>,
}

struct ForwardSession {
    server: Arc<Server>,
}

#[derive(Clone)]
struct ForwardSite {
    request: PortForwardRequest,
    public_url: String,
    capability: String,
    client: GatewayClient,
    http: HttpClient,
    /// When the listener was last confirmed to belong to its terminal.
    verified_at: Arc<Mutex<Option<Instant>>>,
}

impl ForwardSite {
    /// Confirms the listener still belongs to its terminal, at most once per
    /// [`PORT_VERIFY_TTL`]. The lock is held across the check, so a burst of
    /// requests waits on one scan instead of starting one each.
    fn verify_port(&self) -> GatewayResult<()> {
        let mut verified_at = self
            .verified_at
            .lock()
            .map_err(|error| GatewayError::Http(error.to_string()))?;
        if is_verification_fresh(*verified_at, Instant::now()) {
            return Ok(());
        }
        require_open_port(&self.client, &self.request)?;
        *verified_at = Some(Instant::now());
        Ok(())
    }
}

fn is_verification_fresh(verified_at: Option<Instant>, now: Instant) -> bool {
    verified_at.is_some_and(|at| now.saturating_duration_since(at) < PORT_VERIFY_TTL)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesignApplyRequest {
    agent_id: String,
    changes: Vec<DesignStage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesignStage {
    prompt: String,
    html: String,
    selector: String,
    ancestors: String,
    route: String,
    url: String,
}

impl PortForwardRegistry {
    /// Starts or replaces a design-injected forward for one verified listener.
    pub fn forward(
        &self,
        request: PortForwardRequest,
        client: &GatewayClient,
    ) -> GatewayResult<PortForwardResult> {
        require_open_port(client, &request)?;
        let proxy = Arc::new(
            Server::http(("127.0.0.1", 0))
                .map_err(|error| GatewayError::Http(error.to_string()))?,
        );
        let proxy_port = bound_port(&proxy)?;
        let key = forward_key(&request);
        let tunnel = client.rpc(
            ProtocolRpcMethod::Tunnel,
            json!({ "action": "forward", "id": key, "port": proxy_port }),
        )?;
        let url = tunnel
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| GatewayError::InvalidPayload("tunnel returned no URL".to_string()))?
            .trim_end_matches('/')
            .to_string();
        let http = HttpClient::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .build()
            .map_err(|error| GatewayError::Http(error.to_string()))?;
        let capability = Uuid::new_v4().simple().to_string();
        let browser_url = design_browser_url(&url, &capability);
        let site = ForwardSite {
            request,
            public_url: url.clone(),
            capability,
            client: client.clone(),
            http,
            // `require_open_port` passed at the top of this function.
            verified_at: Arc::new(Mutex::new(Some(Instant::now()))),
        };
        let serving = Arc::clone(&proxy);
        thread::spawn(move || {
            for request in serving.incoming_requests() {
                let site = site.clone();
                thread::spawn(move || respond_proxy(request, &site));
            }
        });

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|error| GatewayError::Http(error.to_string()))?;
        if let Some(previous) = sessions.insert(key, ForwardSession { server: proxy }) {
            previous.server.unblock();
        }
        Ok(PortForwardResult { url: browser_url })
    }
}

fn forward_key(request: &PortForwardRequest) -> String {
    format!(
        "{}:{}:{}",
        request.worktree_id, request.tab_id, request.port
    )
}

fn bound_port(server: &Server) -> GatewayResult<u16> {
    let address = server.server_addr().to_string();
    address
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .ok_or_else(|| GatewayError::Http(format!("could not read proxy port from {address}")))
}

fn require_open_port(client: &GatewayClient, request: &PortForwardRequest) -> GatewayResult<()> {
    let ports = client.rpc(
        ProtocolRpcMethod::Ports,
        json!({ "worktreeIds": [&request.worktree_id] }),
    )?;
    if port_is_present(&ports, request) {
        Ok(())
    } else {
        Err(GatewayError::InvalidPayload(
            "port is no longer owned by that terminal".to_string(),
        ))
    }
}

fn port_is_present(ports: &Value, request: &PortForwardRequest) -> bool {
    ports.as_array().is_some_and(|ports| {
        ports.iter().any(|port| {
            port.get("worktreeId").and_then(Value::as_str) == Some(&request.worktree_id)
                && port.get("tabId").and_then(Value::as_str) == Some(&request.tab_id)
                && port.get("pid").and_then(Value::as_u64) == Some(request.pid.get())
                && port.get("port").and_then(Value::as_u64) == Some(request.port.get())
        })
    })
}

fn respond_proxy(mut request: Request, site: &ForwardSite) {
    let response = match proxy_response(&mut request, site) {
        Ok(response) => response,
        Err(error) => proxy_error(&error),
    };
    if let Err(error) = request.respond(response) {
        eprintln!("forwarded port response failed: {error}");
    }
}

fn proxy_response(request: &mut Request, site: &ForwardSite) -> GatewayResult<ResponseBox> {
    let endpoint = format!("/__pragma_design/{}", site.capability);
    let path = request.url().split('?').next().unwrap_or(request.url());
    if path == format!("{endpoint}/catalog") && request.method().as_str() == "GET" {
        return design_catalog(site);
    }
    if path == format!("{endpoint}/apply") && request.method().as_str() == "POST" {
        return design_apply(request, site);
    }
    site.verify_port()?;
    proxy_upstream(request, site)
}

fn design_catalog(site: &ForwardSite) -> GatewayResult<ResponseBox> {
    let catalog = site.client.agent_catalog()?;
    let agents = catalog
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|agent| {
            Some(json!({
                "id": agent.get("id")?.as_str()?,
                "name": agent.get("name")?.as_str()?,
            }))
        })
        .collect::<Vec<_>>();
    json_boxed(200, &json!({ "agents": agents }))
}

fn design_apply(request: &mut Request, site: &ForwardSite) -> GatewayResult<ResponseBox> {
    let payload: DesignApplyRequest = read_proxy_json(request)?;
    validate_design_apply(&payload)?;
    let catalog = site.client.agent_catalog()?;
    let known_agent = catalog
        .get("agents")
        .and_then(Value::as_array)
        .is_some_and(|agents| {
            agents
                .iter()
                .any(|agent| agent.get("id").and_then(Value::as_str) == Some(&payload.agent_id))
        });
    if !known_agent {
        return Err(GatewayError::InvalidPayload("unknown agent".to_string()));
    }
    let prompt = build_design_prompt(&payload.changes, site.request.port.get());
    let result = site.client.control(
        ControlMethod::AgentSessionLaunch,
        json!({
            "projectId": site.request.project_id,
            "worktreeId": site.request.worktree_id,
            "newWorktree": null,
            "agentId": payload.agent_id,
            "modelId": null,
            "reasoningId": null,
            "modelCmd": null,
            "prompt": prompt,
            "headless": true,
        }),
    )?;
    json_boxed(200, &result)
}

fn validate_design_apply(payload: &DesignApplyRequest) -> GatewayResult<()> {
    if payload.agent_id.is_empty() || payload.changes.is_empty() || payload.changes.len() > 50 {
        return Err(GatewayError::InvalidPayload(
            "agent and 1-50 staged changes are required".to_string(),
        ));
    }
    if payload.changes.iter().any(|change| {
        change.prompt.trim().is_empty()
            || change.prompt.len() > 2_000
            || change.html.len() > 4_000
            || change.selector.len() > 2_000
            || change.ancestors.len() > 4_000
            || change.route.len() > 2_000
            || change.url.len() > 4_000
    }) {
        return Err(GatewayError::InvalidPayload(
            "staged design change exceeds its size limit".to_string(),
        ));
    }
    Ok(())
}

fn build_design_prompt(changes: &[DesignStage], port: u64) -> String {
    let plural = if changes.len() == 1 {
        "change"
    } else {
        "changes"
    };
    let mut sections = Vec::with_capacity(changes.len());
    for (index, change) in changes.iter().enumerate() {
        let ancestors = if change.ancestors.is_empty() {
            String::new()
        } else {
            format!("\n- Ancestors: `{}`", change.ancestors)
        };
        sections.push(format!(
            "## Change {}\n\n- Route: `{}`\n- Page: {}\n- Selector: `{}`{}\n\nCode area to change (rendered HTML of the selected element):\n\n```html\n{}\n```\n\nWhat the user asked for:\n\n> {}",
            index + 1,
            change.route,
            change.url,
            change.selector,
            ancestors,
            change.html,
            change.prompt.replace('\n', "\n> ")
        ));
    }
    format!(
        "The user picked {} {} in Pragma's browser using design mode.\nThe app is running locally at http://localhost:{port} (port {port}).\n\nVerify each change below against the running app, find the source that renders the given markup on the given route, then make the change the user asked for.\n\n{}\n\nFor each change: locate the component or template that produces that HTML on that route, apply the requested change, and confirm it renders as expected in the running app.",
        changes.len(),
        plural,
        sections.join("\n\n")
    )
}

fn proxy_upstream(request: &mut Request, site: &ForwardSite) -> GatewayResult<ResponseBox> {
    let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
        .map_err(|error| GatewayError::InvalidPayload(error.to_string()))?;
    let upstream_url = format!("http://127.0.0.1:{}{}", site.request.port, request.url());
    let mut builder = site.http.request(method, upstream_url);
    let mut accept = None;
    let mut client_encoding = None;
    for header in request.headers() {
        let name: &str = header.field.as_str().into();
        if name.eq_ignore_ascii_case("accept") {
            accept = Some(header.value.as_str().to_string());
        } else if name.eq_ignore_ascii_case("accept-encoding") {
            client_encoding = Some(header.value.as_str().to_string());
        }
        if is_forwarded_request_header(name) {
            builder = builder.header(name, header.value.as_str());
        }
    }
    // `header` appends rather than replaces, so the client's own
    // `accept-encoding` is never copied above and exactly one is sent here.
    builder = builder.header(
        "accept-encoding",
        upstream_accept_encoding(accept.as_deref(), client_encoding.as_deref()),
    );
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_PROXY_BODY_BYTES + 1)
        .read_to_end(&mut body)?;
    if body.len() as u64 > MAX_PROXY_BODY_BYTES {
        return Err(GatewayError::InvalidPayload(
            "forwarded request body is too large".to_string(),
        ));
    }
    let upstream = builder
        .body(body)
        .send()
        .map_err(|error| GatewayError::Transport(error.to_string()))?;
    let status = upstream.status().as_u16();
    let headers = upstream.headers().clone();
    if upstream
        .content_length()
        .is_some_and(|size| size > MAX_PROXY_BODY_BYTES)
    {
        return Err(GatewayError::Transport(
            "forwarded response is too large".to_string(),
        ));
    }
    let mut bytes = upstream
        .bytes()
        .map_err(|error| GatewayError::Transport(error.to_string()))?
        .to_vec();
    if bytes.len() as u64 > MAX_PROXY_BODY_BYTES {
        return Err(GatewayError::Transport(
            "forwarded response is too large".to_string(),
        ));
    }
    // A compressed body cannot be edited, so it passes through with its
    // `content-encoding` intact rather than being injected into as text.
    let is_encoded = headers
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.trim().eq_ignore_ascii_case("identity"));
    let is_html = !is_encoded
        && headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
    if is_html {
        bytes = inject_design_runtime(&bytes, site.request.port.get(), &site.public_url);
    }

    let mut response = Response::from_data(bytes).with_status_code(StatusCode(status));
    for (name, value) in &headers {
        let name = name.as_str();
        if is_response_header_allowed(name, is_html) {
            let value = rewrite_location(name, value.to_str().unwrap_or_default(), site);
            if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                response.add_header(header);
            }
        }
    }
    Ok(response.boxed())
}

/// Whether a browser request header is passed on to the forwarded listener.
/// The proxy owns `host` and `accept-encoding`: it rewrites and injects into
/// the body, so the upstream must answer uncompressed.
fn is_forwarded_request_header(name: &str) -> bool {
    !is_hop_header(name)
        && !name.eq_ignore_ascii_case("host")
        && !name.eq_ignore_ascii_case("accept-encoding")
}

fn is_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "authorization"
    )
}

/// The encoding asked of the forwarded listener. A page navigation must come
/// back uncompressed so the design runtime can be injected into it; everything
/// else passes through untouched, so it keeps the browser's own compression.
fn upstream_accept_encoding<'a>(accept: Option<&str>, client_encoding: Option<&'a str>) -> &'a str {
    let navigation = accept.is_some_and(|accept| accept.to_ascii_lowercase().contains("text/html"));
    match client_encoding {
        Some(encoding) if !navigation && !encoding.trim().is_empty() => encoding,
        _ => "identity",
    }
}

fn is_response_header_allowed(name: &str, injected_html: bool) -> bool {
    // `content-encoding` is kept: only an uncompressed body is ever rewritten,
    // and a compressed one reaches the browser byte-for-byte.
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length" | "transfer-encoding" | "connection"
    ) {
        return false;
    }
    !injected_html
        || !matches!(
            name.to_ascii_lowercase().as_str(),
            "content-security-policy" | "content-security-policy-report-only" | "etag"
        )
}

fn rewrite_location(name: &str, value: &str, site: &ForwardSite) -> String {
    if !name.eq_ignore_ascii_case("location") {
        return value.to_string();
    }
    replace_local_origins(value, site.request.port.get(), &site.public_url)
}

fn inject_design_runtime(body: &[u8], port: u64, public_url: &str) -> Vec<u8> {
    let Ok(mut html) = String::from_utf8(body.to_vec()) else {
        return body.to_vec();
    };
    html = replace_local_origins(&html, port, public_url);
    let injection = format!("<script>{DESIGN_RUNTIME}</script>");
    let lower = html.to_ascii_lowercase();
    if let Some(index) = lower
        .find("<head")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
    {
        html.insert_str(index, &injection);
    } else {
        html.insert_str(0, &injection);
    }
    html.into_bytes()
}

fn design_browser_url(public_url: &str, capability: &str) -> String {
    format!("{public_url}#pragma-design={capability}")
}

fn replace_local_origins(value: &str, port: u64, public_url: &str) -> String {
    ["localhost", "127.0.0.1", "0.0.0.0"]
        .iter()
        .fold(value.to_string(), |value, host| {
            value.replace(&format!("http://{host}:{port}"), public_url)
        })
}

fn read_proxy_json<T: serde::de::DeserializeOwned>(request: &mut Request) -> GatewayResult<T> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_PROXY_BODY_BYTES + 1)
        .read_to_end(&mut body)?;
    if body.len() as u64 > MAX_PROXY_BODY_BYTES {
        return Err(GatewayError::InvalidPayload(
            "request is too large".to_string(),
        ));
    }
    serde_json::from_slice(&body).map_err(|error| GatewayError::InvalidPayload(error.to_string()))
}

fn json_boxed<T: serde::Serialize>(status: u16, value: &T) -> GatewayResult<ResponseBox> {
    let mut response =
        Response::from_data(serde_json::to_vec(value)?).with_status_code(StatusCode(status));
    response.add_header(
        Header::from_bytes(&b"content-type"[..], &b"application/json"[..])
            .expect("valid JSON header"),
    );
    Ok(response.boxed())
}

fn proxy_error(error: &GatewayError) -> ResponseBox {
    json_boxed(error.status(), &ErrorBody::from(error)).unwrap_or_else(|_| {
        Response::from_string("forwarded port request failed")
            .with_status_code(StatusCode(500))
            .boxed()
    })
}

const DESIGN_RUNTIME: &str = r#"
(function(){
  const params=new URLSearchParams(location.hash.slice(1)),capability=params.get('pragma-design');
  if(!capability)return;
  history.replaceState(null,'',location.pathname+location.search);
  const endpoint='/__pragma_design/'+encodeURIComponent(capability);
  const send=window.fetch.bind(window);
  if(document.currentScript) document.currentScript.remove();
  const MAX_HTML=4000, PROXIMITY=12;
  const state={enabled:false,selected:null,changes:[],moved:false,startX:0,startY:0,x:innerWidth-68,y:innerHeight-92};
  const host=document.createElement('div');
  host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root=host.attachShadow({mode:'closed'});
  root.innerHTML=`<style>
    *{box-sizing:border-box} .brush{position:fixed;left:0;top:0;width:52px;height:52px;border:0;border-radius:18px;background:#151922;color:#fff;box-shadow:0 10px 30px #0006;display:grid;place-items:center;pointer-events:auto;touch-action:none;cursor:grab}.brush.on{background:#3b76ec}.brush svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.count{position:absolute;right:-5px;top:-5px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#fff;color:#151922;font:700 11px/20px system-ui;display:none}.box{position:fixed;left:0;top:0;border:2px solid #3b76ec;background:#3b76ec22;border-radius:4px;pointer-events:none;display:none}.label{position:fixed;left:0;top:0;padding:3px 7px;border-radius:5px;background:#3b76ec;color:#fff;font:600 11px/1.3 ui-monospace,monospace;pointer-events:none;display:none}.pill{position:fixed;display:none;align-items:center;gap:6px;max-width:calc(100vw - 16px);padding:6px 6px 6px 14px;border:1px solid #ffffff20;border-radius:999px;background:#151922;color:#fff;box-shadow:0 10px 30px #0007;pointer-events:auto}.pill input{all:unset;width:min(240px,calc(100vw - 100px));font:14px system-ui}.pill button,.send button{border:0;border-radius:999px;background:#3b76ec;color:#fff;font:700 14px system-ui}.pill button{width:30px;height:30px}.send{position:fixed;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);display:none;gap:8px;padding:8px;border-radius:18px;background:#151922;color:#fff;box-shadow:0 10px 30px #0007;pointer-events:auto}.send select{max-width:160px;border:1px solid #ffffff25;border-radius:10px;background:#242a36;color:#fff;padding:8px;font:13px system-ui}.send button{padding:8px 12px}.status{align-self:center;padding-left:4px;font:13px system-ui;white-space:nowrap}
  </style><button class="brush" aria-label="Toggle design mode"><svg viewBox="0 0 24 24"><path d="m14.6 4.4 5 5M13 6l5 5M4 20c3 0 5-1.5 5-4.5 0-1.4-1.1-2.5-2.5-2.5S4 14.1 4 15.5V20Zm3.2-7.2L15.5 5a2.1 2.1 0 0 1 3 3l-8.3 8.2"/></svg><span class="count"></span></button><div class="box"></div><div class="label"></div><div class="pill"><input maxlength="2000" placeholder="Describe the change"><button aria-label="Stage change">+</button></div><div class="send"><select aria-label="Agent"></select><button>Run agent</button><span class="status"></span></div>`;
  const brush=root.querySelector('.brush'),box=root.querySelector('.box'),label=root.querySelector('.label'),pill=root.querySelector('.pill'),input=pill.querySelector('input'),stageButton=pill.querySelector('button'),dock=root.querySelector('.send'),select=dock.querySelector('select'),run=dock.querySelector('button'),status=dock.querySelector('.status'),count=brush.querySelector('.count');
  function placeBrush(){state.x=Math.max(8,Math.min(innerWidth-60,state.x));state.y=Math.max(8,Math.min(innerHeight-60,state.y));brush.style.transform=`translate(${state.x}px,${state.y}px)`} placeBrush();
  brush.addEventListener('pointerdown',e=>{state.moved=false;state.startX=e.clientX-state.x;state.startY=e.clientY-state.y;brush.setPointerCapture(e.pointerId)});
  brush.addEventListener('pointermove',e=>{if(!brush.hasPointerCapture(e.pointerId))return;const x=e.clientX-state.startX,y=e.clientY-state.startY;if(Math.hypot(x-state.x,y-state.y)>4)state.moved=true;state.x=x;state.y=y;placeBrush()});
  brush.addEventListener('pointerup',e=>{brush.releasePointerCapture(e.pointerId);if(!state.moved)toggle()});
  function toggle(){state.enabled=!state.enabled;brush.classList.toggle('on',state.enabled);document.documentElement.style.cursor=state.enabled?'crosshair':'';if(!state.enabled)clear()}
  function overlayEvent(e){return e.composedPath().includes(host)}
  function distance(r,x,y){return Math.hypot(Math.max(r.left-x,0,x-r.right),Math.max(r.top-y,0,y-r.bottom))}
  function nearest(x,y){let el=document.elementFromPoint(x,y);if(!el||el===host||el===document.documentElement)return null;for(;;){let best=null,d=PROXIMITY;for(const child of el.children){if(child===host)continue;const r=child.getBoundingClientRect(),n=distance(r,x,y);if((r.width||r.height)&&n<d){best=child;d=n}}if(!best)return el;el=best}}
  function name(el){const id=el.id?'#'+el.id:'';const cls=typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'';return el.tagName.toLowerCase()+id+cls}
  function paint(el,selected){const r=el.getBoundingClientRect();box.style.cssText+=`;display:block;transform:translate(${r.left}px,${r.top}px);width:${r.width}px;height:${r.height}px`;label.textContent=name(el);label.style.cssText+=`;display:block;transform:translate(${r.left}px,${r.top>24?r.top-22:r.bottom+4}px)`;box.style.borderWidth=selected?'2px':'1px'}
  function clear(){state.selected=null;pill.style.display='none';box.style.display='none';label.style.display='none';input.value=''}
  function cssPath(el){const parts=[];for(let cur=el;cur&&cur.nodeType===1&&cur!==document.documentElement;cur=cur.parentElement){if(cur.id){parts.unshift('#'+CSS.escape(cur.id));break}const tag=cur.tagName.toLowerCase(),parent=cur.parentElement;if(!parent){parts.unshift(tag);break}const siblings=[...parent.children].filter(x=>x.tagName===cur.tagName);parts.unshift(siblings.length>1?`${tag}:nth-of-type(${siblings.indexOf(cur)+1})`:tag)}return parts.join(' > ')}
  function ancestors(el){const chain=[];for(let cur=el.parentElement;cur&&cur!==document.documentElement;cur=cur.parentElement)chain.unshift(name(cur));return chain.join(' > ')}
  function choose(el){state.selected=el;paint(el,true);const r=el.getBoundingClientRect();pill.style.display='flex';requestAnimationFrame(()=>{const p=pill.getBoundingClientRect(),left=Math.max(8,Math.min(innerWidth-p.width-8,r.left)),top=r.bottom+p.height+16<innerHeight?r.bottom+8:Math.max(8,r.top-p.height-8);pill.style.transform=`translate(${left}px,${top}px)`;input.focus()})}
  function stage(){if(!state.selected||!input.value.trim())return input.focus();state.changes.push({prompt:input.value.trim(),html:state.selected.outerHTML.slice(0,MAX_HTML),selector:cssPath(state.selected),ancestors:ancestors(state.selected),route:location.pathname+location.search,url:location.href});count.textContent=String(state.changes.length);count.style.display='block';dock.style.display='flex';clear();loadAgents()}
  let loaded=false;async function loadAgents(){if(loaded)return;loaded=true;try{const data=await send(endpoint+'/catalog');const json=await data.json();for(const agent of json.agents||[]){const option=document.createElement('option');option.value=agent.id;option.textContent=agent.name;select.append(option)}}catch(e){status.textContent='Agents unavailable'}}
  async function apply(){if(!select.value||!state.changes.length)return;run.disabled=true;status.textContent='Starting...';try{const response=await send(endpoint+'/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:select.value,changes:state.changes})});if(!response.ok)throw new Error('request failed');state.changes=[];count.style.display='none';dock.style.display='none';status.textContent='';toggle();alert('Agent started in Pragma.')}catch(e){status.textContent='Could not start agent';run.disabled=false}}
  stageButton.addEventListener('click',stage);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();stage()}else if(e.key==='Escape')clear()});run.addEventListener('click',apply);
  addEventListener('pointermove',e=>{if(!state.enabled||state.selected||overlayEvent(e))return;const el=nearest(e.clientX,e.clientY);if(el)paint(el,false)} ,true);
  for(const type of ['pointerdown','mousedown','mouseup','dblclick','contextmenu'])addEventListener(type,e=>{if(state.enabled&&!overlayEvent(e)){e.preventDefault();e.stopPropagation()}},true);
  addEventListener('click',e=>{if(!state.enabled||overlayEvent(e))return;e.preventDefault();e.stopPropagation();const el=nearest(e.clientX,e.clientY);if(el)choose(el)},true);
  addEventListener('resize',placeBrush);document.documentElement.append(host);
})();
"#;

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use super::*;

    fn request() -> PortForwardRequest {
        PortForwardRequest {
            project_id: "project".to_string(),
            worktree_id: "worktree".to_string(),
            tab_id: "tab".to_string(),
            pid: NonZeroU64::new(42).expect("pid"),
            port: NonZeroU64::new(5173).expect("port"),
        }
    }

    #[test]
    fn verifies_the_complete_port_identity() {
        let ports = json!([{
            "worktreeId": "worktree",
            "tabId": "tab",
            "pid": 42,
            "port": 5173,
            "process": "vite"
        }]);
        assert!(port_is_present(&ports, &request()));
        let mut wrong = request();
        wrong.pid = NonZeroU64::new(43).expect("pid");
        assert!(!port_is_present(&ports, &wrong));
    }

    #[test]
    fn injects_runtime_before_page_scripts_and_rewrites_local_origin() {
        let html =
            b"<html><head><script src=\"http://localhost:5173/app.js\"></script></head></html>";
        let output = String::from_utf8(inject_design_runtime(html, 5173, "https://forward.test"))
            .expect("utf8");
        assert!(output.contains("params.get('pragma-design')"));
        assert!(!output.contains("/__pragma_design/token"));
        assert!(output.contains("https://forward.test/app.js"));
        assert!(
            output.find("pragma-design").expect("runtime") < output.find("app.js").expect("app")
        );
    }

    #[test]
    fn never_forwards_the_browser_accept_encoding() {
        assert!(!is_forwarded_request_header("Accept-Encoding"));
        assert!(!is_forwarded_request_header("host"));
        assert!(!is_forwarded_request_header("Authorization"));
        assert!(is_forwarded_request_header("accept"));
        assert!(is_forwarded_request_header("cookie"));
    }

    #[test]
    fn asks_for_identity_only_on_page_navigations() {
        let page = Some("text/html,application/xhtml+xml,*/*;q=0.8");
        assert_eq!(upstream_accept_encoding(page, Some("gzip, br")), "identity");
        assert_eq!(
            upstream_accept_encoding(Some("*/*"), Some("gzip, br")),
            "gzip, br"
        );
        assert_eq!(upstream_accept_encoding(None, Some("gzip")), "gzip");
        assert_eq!(upstream_accept_encoding(Some("*/*"), None), "identity");
        assert_eq!(
            upstream_accept_encoding(Some("*/*"), Some("  ")),
            "identity"
        );
    }

    #[test]
    fn passes_content_encoding_through() {
        assert!(is_response_header_allowed("Content-Encoding", false));
        assert!(is_response_header_allowed("content-encoding", true));
        assert!(!is_response_header_allowed("content-length", false));
        assert!(!is_response_header_allowed("etag", true));
    }

    #[test]
    fn reuses_a_recent_ownership_check() {
        let now = Instant::now();
        assert!(!is_verification_fresh(None, now));
        assert!(is_verification_fresh(Some(now), now));
        assert!(!is_verification_fresh(
            now.checked_sub(PORT_VERIFY_TTL),
            now
        ));
    }

    #[test]
    fn keeps_design_capability_in_browser_fragment() {
        assert_eq!(
            design_browser_url("https://forward.test", "secret"),
            "https://forward.test#pragma-design=secret"
        );
    }

    #[test]
    fn builds_local_design_prompt() {
        let prompt = build_design_prompt(
            &[DesignStage {
                prompt: "Make it blue".to_string(),
                html: "<button>Save</button>".to_string(),
                selector: "button".to_string(),
                ancestors: "main".to_string(),
                route: "/settings".to_string(),
                url: "https://forward.test/settings".to_string(),
            }],
            5173,
        );
        assert!(prompt.contains("http://localhost:5173"));
        assert!(prompt.contains("Make it blue"));
        assert!(prompt.contains("<button>Save</button>"));
    }
}
