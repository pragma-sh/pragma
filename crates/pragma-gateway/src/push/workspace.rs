//! Mirror of the desktop's published workspace, used to name a report's location.

use std::sync::{Arc, Mutex};

use pragma_constants::{TabKind, CONSTANTS};
use pragma_protocol::WorkspaceSnapshot;

use super::text::AlertLocation;

/// The most recent `WorkspaceSnapshot` the host has published.
///
/// The desktop republishes the whole snapshot on every mutation, so keeping the
/// latest one is enough to turn the ids in an agent report into project,
/// worktree, and tab names.
#[derive(Clone, Default)]
pub struct WorkspaceMirror {
    snapshot: Arc<Mutex<Option<WorkspaceSnapshot>>>,
}

impl WorkspaceMirror {
    /// Replaces the mirrored snapshot.
    pub fn replace(&self, snapshot: WorkspaceSnapshot) {
        if let Ok(mut current) = self.snapshot.lock() {
            *current = Some(snapshot);
        }
    }

    /// Names the project/worktree/tab an agent report came from. Unresolvable
    /// parts stay `None`, and the renderer drops them.
    #[must_use]
    pub fn locate(&self, worktree_id: &str, tab_id: &str) -> AlertLocation {
        let Ok(snapshot) = self.snapshot.lock() else {
            return AlertLocation::default();
        };
        let Some(snapshot) = snapshot.as_ref() else {
            return AlertLocation::default();
        };
        let worktree = snapshot
            .worktrees
            .iter()
            .find(|worktree| worktree.id == worktree_id);
        let project = worktree.and_then(|worktree| {
            snapshot
                .projects
                .iter()
                .find(|project| project.id == worktree.project_id)
        });
        let tab = snapshot.tabs.iter().find(|tab| tab.id == tab_id);
        AlertLocation {
            project_name: project.map(|project| project.name.clone()),
            worktree_name: worktree.map(|worktree| {
                worktree
                    .title
                    .clone()
                    .unwrap_or_else(|| worktree.branch.clone())
            }),
            tab_name: tab.and_then(|tab| named_tab_title(tab.title.as_deref(), tab.kind)),
        }
    }
}

/// A tab still carrying the default title for its kind says nothing the
/// worktree name does not, so only a real name is worth putting in an alert.
fn named_tab_title(title: Option<&str>, kind: TabKind) -> Option<String> {
    let title = title.map(str::trim).filter(|title| !title.is_empty())?;
    if title == default_tab_title(kind) {
        return None;
    }
    Some(title.to_string())
}

/// Rust twin of `defaultTabTitle` in `apps/pragma/src/lib/tab-title.ts`; both
/// read the same shipped titles.
fn default_tab_title(kind: TabKind) -> &'static str {
    let titles = &CONSTANTS.tabs.default_titles;
    match kind {
        TabKind::Browser => titles.browser.as_str(),
        TabKind::Log => titles.log.as_str(),
        TabKind::PrReview => titles.pr_review.as_str(),
        TabKind::PluginWebview => titles.plugin_webview.as_str(),
        TabKind::Scratchpad => titles.scratchpad.as_str(),
        TabKind::Terminal | TabKind::Editor | TabKind::Diff => titles.fallback.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::{named_tab_title, WorkspaceMirror};
    use pragma_constants::{Project, Tab, TabKind, Worktree};
    use pragma_protocol::WorkspaceSnapshot;

    fn snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            projects: vec![Project {
                id: "project-1".to_string(),
                name: "pragma".to_string(),
                path: "/repo".to_string(),
                order_index: 0,
                created_at: "now".to_string(),
            }],
            worktrees: vec![Worktree {
                id: "worktree-1".to_string(),
                project_id: "project-1".to_string(),
                parent_id: None,
                branch: "bugfix-auth".to_string(),
                title: None,
                path: "/repo/wt".to_string(),
                is_main: false,
                hidden: false,
                created_at: "now".to_string(),
            }],
            tabs: vec![Tab {
                id: "tab-1".to_string(),
                project_id: "project-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                kind: TabKind::Terminal,
                title: Some("dev".to_string()),
                url: None,
                file_path: None,
                diff_side: None,
                diff_commit: None,
                pr_number: None,
                plugin_id: None,
                plugin_view_id: None,
                plugin_payload: None,
                plugin_dedupe_key: None,
                agent_id: None,
                user_renamed: false,
                order_index: 0,
                created_at: "now".to_string(),
            }],
        }
    }

    #[test]
    fn locates_names_from_the_snapshot() {
        let mirror = WorkspaceMirror::default();
        mirror.replace(snapshot());

        let location = mirror.locate("worktree-1", "tab-1");

        assert_eq!(location.project_name.as_deref(), Some("pragma"));
        assert_eq!(location.worktree_name.as_deref(), Some("bugfix-auth"));
        assert_eq!(location.tab_name.as_deref(), Some("dev"));
    }

    #[test]
    fn leaves_unknown_ids_unnamed() {
        let mirror = WorkspaceMirror::default();
        mirror.replace(snapshot());

        let location = mirror.locate("worktree-missing", "tab-missing");

        assert_eq!(location.project_name, None);
        assert_eq!(location.worktree_name, None);
        assert_eq!(location.tab_name, None);
    }

    #[test]
    fn ignores_a_tab_still_using_its_default_title() {
        assert_eq!(named_tab_title(Some("Shell"), TabKind::Terminal), None);
        assert_eq!(named_tab_title(Some("New tab"), TabKind::Browser), None);
        assert_eq!(named_tab_title(Some("  "), TabKind::Terminal), None);
        assert_eq!(
            named_tab_title(Some("Shell"), TabKind::Browser),
            Some("Shell".to_string())
        );
    }
}
