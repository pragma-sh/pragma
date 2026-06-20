#[cfg(any(target_os = "macos", test))]
use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "macos")]
const AGENT_NOTIFICATION_CLICKED_EVENT: &str = "pragma:agent-notification-clicked";

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentNotificationClick {
    #[serde(rename = "projectId")]
    project: String,
    #[serde(rename = "worktreeId")]
    worktree: String,
    #[serde(rename = "tabId")]
    tab: String,
}

/// Shows a clickable native agent notification when the platform supports it.
///
/// Returns `false` when the frontend should fall back to the regular Tauri
/// notification plugin. macOS is handled here because that plugin does not
/// expose notification activation events back to JavaScript.
#[tauri::command]
pub fn show_agent_notification(
    app_handle: tauri::AppHandle,
    title: String,
    body: String,
    project_id: String,
    worktree_id: String,
    tab_id: String,
) -> bool {
    show_clickable_notification(app_handle, title, body, project_id, worktree_id, tab_id)
}

#[cfg(target_os = "macos")]
fn show_clickable_notification(
    app_handle: tauri::AppHandle,
    title: String,
    body: String,
    project_id: String,
    worktree_id: String,
    tab_id: String,
) -> bool {
    let identifier = app_handle.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mac_notification_sys::set_application(&identifier);
        let mut notification = mac_notification_sys::Notification::new();
        notification
            .title(&title)
            .message(&body)
            .wait_for_click(true);
        match notification.send() {
            Ok(
                mac_notification_sys::NotificationResponse::Click
                | mac_notification_sys::NotificationResponse::ActionButton(_),
            ) => {
                let _ = app_handle.emit(
                    AGENT_NOTIFICATION_CLICKED_EVENT,
                    AgentNotificationClick {
                        project: project_id,
                        worktree: worktree_id,
                        tab: tab_id,
                    },
                );
            }
            Ok(_) => {}
            Err(error) => log::warn!("failed to show clickable macOS notification: {error}"),
        }
    });
    true
}

#[cfg(not(target_os = "macos"))]
fn show_clickable_notification(
    _app_handle: tauri::AppHandle,
    _title: String,
    _body: String,
    _project_id: String,
    _worktree_id: String,
    _tab_id: String,
) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_payload_uses_camel_case() {
        let value = serde_json::to_value(AgentNotificationClick {
            project: "project".into(),
            worktree: "worktree".into(),
            tab: "tab".into(),
        })
        .unwrap();

        assert_eq!(value["projectId"], "project");
        assert_eq!(value["worktreeId"], "worktree");
        assert_eq!(value["tabId"], "tab");
    }
}
