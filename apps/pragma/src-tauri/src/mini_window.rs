//! Pragma Mini: lightweight terminal windows next to the main workspace.
//!
//! A mini window is an ordinary webview window running the same frontend
//! bundle; the frontend renders the mini UI when its label starts with
//! `constants.miniWindow.labelPrefix`. Its tabs are not persisted — they live
//! as long as the window — and open in the home directory, routed to the local
//! host through the `homeWorktreeId` sentinel (see `Hosts::host_id_for_worktree`).
//!
//! Three entry points open one: the menu bar (File → New Pragma Mini Window),
//! the dock / taskbar icon menu (`pragma_platform::dock`), and a relaunch with
//! `constants.miniWindow.launchArg` (Windows jump list, Linux desktop action),
//! which the single-instance guard forwards to the running app.
//!
//! Native menu actions are routed to the focused window ([`menu_target`]):
//! the tab actions a mini window implements go to it, everything else goes to
//! the main window, which is raised so the action is visible.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use pragma_constants::CONSTANTS;
use pragma_platform::dock::{self, DockAction, DockInstall};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::hosts::Hosts;
use crate::{updates, window_chrome};

/// Label of the app's main window.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Whether a window label belongs to a Pragma Mini window.
#[must_use]
pub fn is_mini_label(label: &str) -> bool {
    label.starts_with(CONSTANTS.mini_window.label_prefix.as_str())
}

/// The PTY sessions each mini window spawned, so they end with the window.
///
/// A mini tab is not persisted, so nothing would ever reattach to its session
/// once its window is gone — and the server deliberately keeps sessions alive
/// across app restarts. Closing a window, or quitting the app (which never asks
/// the webviews), therefore kills them here rather than trusting the frontend.
#[derive(Default)]
pub struct MiniSessions(Mutex<HashMap<String, HashSet<String>>>);

impl MiniSessions {
    /// Records that `window` spawned `session_id` (ignored for non-mini windows).
    pub fn track(&self, window: &str, session_id: &str) {
        if !is_mini_label(window) {
            return;
        }
        if let Ok(mut map) = self.0.lock() {
            map.entry(window.to_string())
                .or_default()
                .insert(session_id.to_string());
        }
    }

    /// Removes and returns the sessions of `window`.
    fn take(&self, window: &str) -> Vec<String> {
        self.0
            .lock()
            .ok()
            .and_then(|mut map| map.remove(window))
            .map(|sessions| sessions.into_iter().collect())
            .unwrap_or_default()
    }

    /// Removes and returns every tracked session.
    fn take_all(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut map| map.drain().flat_map(|(_, sessions)| sessions).collect())
            .unwrap_or_default()
    }
}

/// Kills the sessions a destroyed mini window left behind, off the main thread.
pub fn end_window_sessions(app: &AppHandle, window: &str) {
    let sessions = app.state::<MiniSessions>().take(window);
    kill_sessions(app, sessions, false);
}

/// Kills every mini session before the app exits. Blocks, so the kills land
/// before the process does.
pub fn end_all_sessions(app: &AppHandle) {
    let Some(state) = app.try_state::<MiniSessions>() else {
        return;
    };
    kill_sessions(app, state.take_all(), true);
}

fn kill_sessions(app: &AppHandle, sessions: Vec<String>, wait: bool) {
    if sessions.is_empty() {
        return;
    }
    let hosts = app.state::<Hosts>();
    let clients: Vec<_> = sessions
        .into_iter()
        .filter_map(|session| {
            let client = hosts.for_session(&session).ok()?;
            let _ = hosts.unbind_session(&session);
            Some((client, session))
        })
        .collect();
    let worker = std::thread::spawn(move || {
        for (client, session) in clients {
            // An already-exited shell (the user typed `exit`) is not an error.
            let _ = client.kill(session);
        }
    });
    if wait {
        let _ = worker.join();
    }
}

/// Whether a command line asks for a new mini window.
#[must_use]
pub fn wants_mini<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> bool {
    let flag = CONSTANTS.mini_window.launch_arg.as_str();
    args.into_iter().any(|arg| arg.as_ref() == flag)
}

/// Opens a new mini window and focuses it.
///
/// # Errors
///
/// Returns the Tauri error when the window cannot be built.
pub fn open(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = &CONSTANTS.mini_window;
    let label = format!(
        "{}{}",
        config.label_prefix.as_str(),
        uuid::Uuid::new_v4().simple()
    );
    let url = updates::active_ui_overlay_url(app).map_or_else(
        || WebviewUrl::App("index.html".into()),
        WebviewUrl::External,
    );
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .inner_size(
            as_f64(config.default_width.get()),
            as_f64(config.default_height.get()),
        )
        .min_inner_size(
            as_f64(config.min_width.get()),
            as_f64(config.min_height.get()),
        )
        .resizable(true)
        .theme(Some(tauri::Theme::Dark))
        .disable_drag_drop_handler();
    // Same chrome as the main window's `tauri.macos.conf.json` entry: a
    // transparent window under an overlay titlebar, so vibrancy and the inset
    // traffic lights match.
    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    let title = format!("{} Mini", window_chrome::product_name(&window));
    window_chrome::apply_titled(&window, &title);
    let _ = window.set_focus();
    Ok(window)
}

/// Opens a mini window off the calling thread (menu and dock callbacks run
/// inside `AppKit` event dispatch, where building a webview synchronously is
/// not safe on every platform). Failures are logged.
pub fn open_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open(&app) {
            log::warn!("failed to open a Pragma Mini window: {error}");
        }
    });
}

/// Adds "New Pragma Mini Window" to the dock / taskbar icon menu. Must run on
/// the main thread after the event loop has started (`RunEvent::Ready`).
pub fn install_dock_menu(app: &AppHandle) {
    let handle = app.clone();
    let actions = [DockAction {
        title: CONSTANTS.mini_window.menu_title.to_string(),
        arg: CONSTANTS.mini_window.launch_arg.to_string(),
    }];
    match dock::install(&actions, Box::new(move |_| open_in_background(&handle))) {
        Ok(DockInstall::Installed) => {}
        Ok(DockInstall::DesktopEntry) => {
            log::info!("dock actions come from the bundled .desktop entry");
        }
        Err(error) => log::warn!("failed to install the dock menu: {error}"),
    }
}

/// Which window a native menu action should reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuTarget {
    /// The focused mini window, which implements the action itself.
    Mini(String),
    /// The main window; `raise` brings it forward because focus was elsewhere.
    Main { raise: bool },
}

/// Routes a menu action given the focused window's label. `mini_handles` is
/// whether a mini window implements the action (new tab, close tab).
#[must_use]
pub fn route_menu_action(focused: Option<&str>, mini_handles: bool) -> MenuTarget {
    match focused {
        Some(label) if is_mini_label(label) && mini_handles => MenuTarget::Mini(label.to_string()),
        Some(label) if is_mini_label(label) => MenuTarget::Main { raise: true },
        _ => MenuTarget::Main { raise: false },
    }
}

/// Resolves [`route_menu_action`] against the live windows and returns the
/// label to emit to, raising the main window when the action moves focus there.
pub fn menu_target(app: &AppHandle, mini_handles: bool) -> String {
    let focused = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    match route_menu_action(focused.as_deref(), mini_handles) {
        MenuTarget::Mini(label) => label,
        MenuTarget::Main { raise } => {
            if raise {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            MAIN_WINDOW_LABEL.to_string()
        }
    }
}

#[allow(clippy::cast_precision_loss)] // Window sizes are small positive integers.
fn as_f64(value: u64) -> f64 {
    value as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mini_label() -> String {
        format!("{}abc", CONSTANTS.mini_window.label_prefix.as_str())
    }

    #[test]
    fn tracks_sessions_per_mini_window_only() {
        let sessions = MiniSessions::default();
        let label = mini_label();
        sessions.track(&label, "mini-1");
        sessions.track(&label, "mini-2");
        sessions.track(MAIN_WINDOW_LABEL, "tab-1");
        let mut taken = sessions.take(&label);
        taken.sort();
        assert_eq!(taken, ["mini-1", "mini-2"]);
        assert_eq!(sessions.take_all(), Vec::<String>::new());
    }

    #[test]
    fn recognises_mini_labels() {
        assert!(is_mini_label(&mini_label()));
        assert!(!is_mini_label(MAIN_WINDOW_LABEL));
    }

    #[test]
    fn detects_the_launch_argument() {
        let flag = CONSTANTS.mini_window.launch_arg.as_str();
        assert!(wants_mini(["pragma", flag]));
        assert!(!wants_mini(["pragma", "pragma://open"]));
    }

    #[test]
    fn tab_actions_stay_in_the_focused_mini_window() {
        let label = mini_label();
        assert_eq!(
            route_menu_action(Some(&label), true),
            MenuTarget::Mini(label.clone())
        );
    }

    #[test]
    fn workspace_actions_from_a_mini_window_raise_main() {
        assert_eq!(
            route_menu_action(Some(&mini_label()), false),
            MenuTarget::Main { raise: true }
        );
    }

    #[test]
    fn main_window_keeps_every_action() {
        assert_eq!(
            route_menu_action(Some(MAIN_WINDOW_LABEL), true),
            MenuTarget::Main { raise: false }
        );
        assert_eq!(
            route_menu_action(None, true),
            MenuTarget::Main { raise: false }
        );
    }

    #[test]
    fn desktop_entry_declares_the_launch_argument() {
        let entry = include_str!("../linux/pragma.desktop");
        let exec = format!(
            "Exec={{{{exec}}}} {}",
            CONSTANTS.mini_window.launch_arg.as_str()
        );
        assert!(
            entry.contains(&exec),
            "desktop action must relaunch with the launch arg"
        );
        assert!(entry.contains(&format!(
            "Name={}",
            CONSTANTS.mini_window.menu_title.as_str()
        )));
    }
}
