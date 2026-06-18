use std::thread;
use std::time::Duration;

use pragma_protocol::{
    read_frame, write_json_frame, AgentReportPayload, EventFrame, Frame, RequestFrame, RequestKind,
    ServerFrame,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::pty::PtyClient;

const AGENT_REPORT_EVENT: &str = "pragma:agent-report";

/// Starts the long-lived daemon subscription that forwards agent status events to React.
pub fn start(app: AppHandle, pty: PtyClient) {
    thread::spawn(move || loop {
        if let Err(error) = subscribe_once(&app, &pty) {
            log::warn!("agent event bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn subscribe_once(app: &AppHandle, pty: &PtyClient) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::SubscribeAgents,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
    };
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
                Ok(ServerFrame::Hello(_) | ServerFrame::Response(_) | ServerFrame::Event(_))
                | Err(_) => {}
            },
            Frame::Output { .. } => {}
        }
    }
}
