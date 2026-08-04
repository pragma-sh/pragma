//! Renders an agent alert into notification text.
//!
//! Deliberately mirrors `apps/pragma/src/lib/agent-notification-text.ts`: the
//! phone push and the desktop toast describe the same event, so both read the
//! templates in `agentStatus.notificationText` and substitute the same fields.

use pragma_constants::CONSTANTS;
use pragma_protocol::{AgentAttentionKind, AgentStatus};

/// Where a report came from, in names a person recognises. Every field is
/// optional: a report can arrive before the desktop has mirrored its workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[allow(
    clippy::struct_field_names,
    reason = "each field names a distinct place"
)]
pub struct AlertLocation {
    pub project_name: Option<String>,
    pub worktree_name: Option<String>,
    pub tab_name: Option<String>,
}

/// Substitutes `{key}` placeholders; an unknown placeholder is left as-is.
fn render(template: &str, key: &str, value: &str) -> String {
    template.replace(&format!("{{{key}}}"), value)
}

/// Headline: the agent's display name plus what it wants.
#[must_use]
pub fn alert_title(
    status: Option<AgentStatus>,
    attention_kind: Option<AgentAttentionKind>,
    agent_name: &str,
) -> String {
    let text = &CONSTANTS.agent_status.notification_text;
    let template = match (status, attention_kind) {
        (Some(AgentStatus::Done), _) => &text.done_title,
        (_, Some(AgentAttentionKind::Command)) => &text.command_title,
        (_, Some(AgentAttentionKind::Question)) => &text.question_title,
        _ => &text.attention_title,
    };
    render(template, "agent", agent_name)
}

/// Body: which project/worktree (and tab) the agent is in.
#[must_use]
pub fn alert_body(location: &AlertLocation) -> String {
    let text = &CONSTANTS.agent_status.notification_text;
    let place = [&location.project_name, &location.worktree_name]
        .into_iter()
        .filter_map(|part| {
            part.as_deref()
                .map(str::trim)
                .filter(|part| !part.is_empty())
        })
        .collect::<Vec<_>>()
        .join(&text.location_separator);
    let tab = location
        .tab_name
        .as_deref()
        .map(str::trim)
        .filter(|tab| !tab.is_empty());
    match (place.is_empty(), tab) {
        // Nothing to hang the suffix off, so drop its leading separator.
        (true, Some(tab)) => render(&text.tab_suffix, "tab", tab)
            .trim_start_matches(|character: char| !character.is_alphanumeric())
            .to_string(),
        (true, None) => text.unknown_location.clone(),
        (false, Some(tab)) => format!("{place}{}", render(&text.tab_suffix, "tab", tab)),
        (false, None) => place,
    }
}

#[cfg(test)]
mod tests {
    use super::{alert_body, alert_title, AlertLocation};
    use pragma_protocol::{AgentAttentionKind, AgentStatus};

    #[test]
    fn title_names_the_agent_and_what_it_wants() {
        assert_eq!(
            alert_title(Some(AgentStatus::Done), None, "OpenCode"),
            "OpenCode finished"
        );
        assert_eq!(
            alert_title(
                Some(AgentStatus::Attention),
                Some(AgentAttentionKind::Question),
                "Claude Code"
            ),
            "Claude Code is waiting for an answer"
        );
        assert_eq!(
            alert_title(
                Some(AgentStatus::Attention),
                Some(AgentAttentionKind::Command),
                "Codex"
            ),
            "Codex wants to run a command"
        );
        assert_eq!(
            alert_title(Some(AgentStatus::Attention), None, "Cursor"),
            "Cursor needs attention"
        );
    }

    #[test]
    fn body_reads_project_then_worktree_then_tab() {
        assert_eq!(
            alert_body(&AlertLocation {
                project_name: Some("pragma".to_string()),
                worktree_name: Some("bugfix-auth".to_string()),
                tab_name: Some("dev".to_string()),
            }),
            "pragma / bugfix-auth · tab \"dev\""
        );
    }

    #[test]
    fn body_drops_missing_parts() {
        assert_eq!(
            alert_body(&AlertLocation {
                project_name: Some("pragma".to_string()),
                worktree_name: Some("  ".to_string()),
                tab_name: None,
            }),
            "pragma"
        );
        assert_eq!(
            alert_body(&AlertLocation {
                tab_name: Some("dev".to_string()),
                ..AlertLocation::default()
            }),
            "tab \"dev\""
        );
        assert_eq!(
            alert_body(&AlertLocation::default()),
            "Open Pragma to continue."
        );
    }
}
