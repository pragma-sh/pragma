use std::thread;
use std::time::Duration;

use pragma_client::request_subscribe_agents;
use pragma_protocol::{
    read_frame, write_json_frame, AgentReportPayload, EventFrame, Frame, ServerFrame,
};
use tauri::{AppHandle, Emitter};

use crate::pty::PtyClient;

const AGENT_REPORT_EVENT: &str = "pragma:agent-report";
const AGENT_STATUS_RESET_EVENT: &str = "pragma:agent-status-reset";

/// Starts a long-lived agent event subscription for one connected host client.
pub fn start_for(app: AppHandle, client: PtyClient) {
    thread::spawn(move || loop {
        if let Err(error) = subscribe_once(&app, &client) {
            log::warn!("agent event bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn subscribe_once(app: &AppHandle, pty: &PtyClient) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe_agents();
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    loop {
        match read_frame(&mut stream).map_err(|error| error.to_string())? {
            Frame::Json(bytes) => match serde_json::from_slice::<ServerFrame>(&bytes) {
                Ok(ServerFrame::Response(response))
                    if response.request_id == request.request_id =>
                {
                    if !response.ok {
                        return Err(response
                            .error
                            .unwrap_or_else(|| "agent subscription rejected".to_string()));
                    }
                    let _ = app.emit(AGENT_STATUS_RESET_EVENT, ());
                }
                Ok(ServerFrame::Event(EventFrame::Agent {
                    worktree_id,
                    tab_id,
                    agent,
                    status,
                    attention_kind,
                })) => {
                    let payload = AgentReportPayload {
                        agent,
                        worktree_id,
                        tab_id,
                        status,
                        attention_kind,
                    };
                    let _ = app.emit(AGENT_REPORT_EVENT, payload);
                }
                Ok(
                    ServerFrame::Hello(_)
                    | ServerFrame::Response(_)
                    | ServerFrame::Rpc(_)
                    | ServerFrame::Event(_),
                )
                | Err(_) => {}
            },
            Frame::Output { .. } => {}
        }
    }
}
