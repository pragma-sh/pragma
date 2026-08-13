//! Pure fanout domain logic: selector resolution, identity/branch naming,
//! status aggregation, and scratchpad promotion naming.
//!
//! Everything here is deterministic and side-effect free so it can be tested
//! without a server, a plugin catalog sidecar, or a git checkout. The durable
//! record, provisioning, and the destructive pick transaction live in
//! `pragma-server`'s `FanoutRegistry`, which calls into this module.

use pragma_constants::{
    Fanout, FanoutFailure, FanoutFailureCode, FanoutMemberStatus, FanoutStatus, CONSTANTS,
};

/// One agent the host catalog offers, reduced to what selector resolution needs.
///
/// `runtime_agent_id` is deliberately carried rather than derived: the agent
/// event stream is keyed by the plugin's own watcher id, which is *not*
/// reliably the last dotted segment of the catalog id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogAgentView {
    /// Fully qualified catalog id (`plugin.agent`).
    pub id: String,
    /// Runtime reporter/watcher id the agent event stream is keyed by.
    pub runtime_agent_id: String,
    /// Selectable models, in catalog order. The first is the default.
    pub models: Vec<CatalogModelView>,
}

/// One selectable model plus the reasoning efforts it offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogModelView {
    pub id: String,
    pub reasoning_ids: Vec<String>,
}

/// A fully resolved member selection, ready to be persisted and launched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSelector {
    pub selector: String,
    pub catalog_agent_id: String,
    pub runtime_agent_id: String,
    pub model_id: Option<String>,
    pub reasoning_id: Option<String>,
}

/// Builds a fanout failure with no member attached.
#[must_use]
pub fn failure(code: FanoutFailureCode, message: impl Into<String>) -> FanoutFailure {
    FanoutFailure {
        code,
        message: message.into(),
        member_id: None,
        stage: None,
    }
}

/// Builds a fanout failure attributed to one member.
#[must_use]
pub fn member_failure(
    code: FanoutFailureCode,
    member_id: impl Into<String>,
    message: impl Into<String>,
) -> FanoutFailure {
    FanoutFailure {
        code,
        message: message.into(),
        member_id: Some(member_id.into()),
        stage: None,
    }
}

/// Resolves one `agent[.model[.reasoning]]` selector against the catalog.
///
/// Resolution order matches the desktop's deep-link selector so one string
/// means the same thing everywhere:
///
/// 1. the longest registered catalog agent id that prefixes the selector;
/// 2. the remaining text as an **exact** model id;
/// 3. only then the final dotted segment as a reasoning id.
///
/// `default_reasoning` fills in when the selector names none. A default that
/// the resolved model does not offer is an error rather than a silent drop —
/// launching at the wrong effort is worse than refusing.
pub fn resolve_selector(
    catalog: &[CatalogAgentView],
    selector: &str,
    default_reasoning: Option<&str>,
) -> Result<ResolvedSelector, FanoutFailure> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(failure(
            FanoutFailureCode::InvalidSelector,
            "agent selector is empty",
        ));
    }
    let agent = longest_agent_prefix(catalog, selector).ok_or_else(|| {
        failure(
            FanoutFailureCode::UnknownAgent,
            format!("no catalog agent matches selector `{selector}`"),
        )
    })?;
    let remainder = selector[agent.id.len()..].trim_start_matches('.');
    let (model_id, reasoning_id) = split_model_and_reasoning(agent, remainder, selector)?;
    let reasoning_id = match reasoning_id {
        Some(reasoning) => Some(reasoning),
        None => resolve_default_reasoning(agent, model_id.as_deref(), default_reasoning, selector)?,
    };
    Ok(ResolvedSelector {
        selector: selector.to_string(),
        catalog_agent_id: agent.id.clone(),
        runtime_agent_id: agent.runtime_agent_id.clone(),
        model_id,
        reasoning_id,
    })
}

/// The longest catalog agent id that is `selector` itself or a dot-delimited
/// prefix of it. Longest wins so `pragma.opencode` beats a hypothetical
/// `pragma` agent.
fn longest_agent_prefix<'a>(
    catalog: &'a [CatalogAgentView],
    selector: &str,
) -> Option<&'a CatalogAgentView> {
    catalog
        .iter()
        .filter(|agent| {
            selector == agent.id
                || (selector.starts_with(&agent.id) && selector[agent.id.len()..].starts_with('.'))
        })
        .max_by_key(|agent| agent.id.len())
}

/// Splits the post-agent remainder into an optional model and reasoning id.
fn split_model_and_reasoning(
    agent: &CatalogAgentView,
    remainder: &str,
    selector: &str,
) -> Result<(Option<String>, Option<String>), FanoutFailure> {
    if remainder.is_empty() {
        return Ok((None, None));
    }
    // An exact model id wins outright: model ids routinely contain dots
    // (`openai/gpt-5.6`), so splitting first would mangle them.
    if let Some(model) = agent.models.iter().find(|model| model.id == remainder) {
        return Ok((Some(model.id.clone()), None));
    }
    if let Some((head, tail)) = remainder.rsplit_once('.') {
        if let Some(model) = agent.models.iter().find(|model| model.id == head) {
            if model.reasoning_ids.iter().any(|id| id == tail) {
                return Ok((Some(model.id.clone()), Some(tail.to_string())));
            }
            return Err(failure(
                FanoutFailureCode::UnknownReasoning,
                format!("model `{head}` does not offer reasoning effort `{tail}`"),
            ));
        }
    }
    // No model matched, so the whole remainder may be a reasoning effort on
    // the agent's default model (`opencode.high`).
    if let Some(default) = agent.models.first() {
        if default.reasoning_ids.iter().any(|id| id == remainder) {
            return Ok((None, Some(remainder.to_string())));
        }
    }
    Err(failure(
        FanoutFailureCode::UnknownModel,
        format!(
            "agent `{}` has no model `{remainder}` (from `{selector}`)",
            agent.id
        ),
    ))
}

/// Applies the request-wide reasoning default, erroring when the resolved model
/// does not offer it.
fn resolve_default_reasoning(
    agent: &CatalogAgentView,
    model_id: Option<&str>,
    default_reasoning: Option<&str>,
    selector: &str,
) -> Result<Option<String>, FanoutFailure> {
    let Some(default) = default_reasoning.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let model = match model_id {
        Some(id) => agent.models.iter().find(|model| model.id == id),
        None => agent.models.first(),
    };
    // An agent with no catalog models at all has no reasoning to validate
    // against; its launch command is model-less, so the default cannot apply.
    let Some(model) = model else {
        return Ok(None);
    };
    if model.reasoning_ids.iter().any(|id| id == default) {
        return Ok(Some(default.to_string()));
    }
    Err(failure(
        FanoutFailureCode::UnknownReasoning,
        format!(
            "`{selector}` resolves to model `{}`, which does not offer reasoning effort `{default}`",
            model.id
        ),
    ))
}

/// Deterministic attempt branch: `<prefix>/<fanout-short>/<member-short>`.
///
/// Derived from ids rather than from the prompt so two fanouts with the same
/// title never collide, and so a retry reuses the member's existing branch.
#[must_use]
pub fn attempt_branch(fanout_id: &str, member_id: &str) -> String {
    format!(
        "{}/{}/{}",
        CONSTANTS.fanout.branch_prefix,
        short_id(fanout_id),
        short_id(member_id)
    )
}

/// The first 8 characters of an id, used in branch names and text output.
#[must_use]
pub fn short_id(id: &str) -> String {
    id.chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect()
}

/// Display title for a fanout with none supplied: the prompt's first non-empty
/// line, bounded so a pasted essay does not become a sidebar row.
#[must_use]
pub fn derive_title(prompt: &str) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Fanout");
    let truncated: String = line.chars().take(TITLE_MAX_CHARS).collect();
    if truncated.chars().count() < line.chars().count() {
        format!("{}…", truncated.trim_end())
    } else {
        truncated
    }
}

const TITLE_MAX_CHARS: usize = 72;

/// Rolls the member statuses up into the fanout's own status.
///
/// Terminal fanout states (`cancelled`, `completed`, `needsResolution`,
/// `cleanupFailed`, `finalizing`) are owned by the pick transaction and are
/// never re-derived from members, so they are returned unchanged.
#[must_use]
pub fn aggregate_status(current: FanoutStatus, members: &[FanoutMemberStatus]) -> FanoutStatus {
    if matches!(
        current,
        FanoutStatus::Cancelled
            | FanoutStatus::Completed
            | FanoutStatus::Finalizing
            | FanoutStatus::NeedsResolution
            | FanoutStatus::CleanupFailed
    ) {
        return current;
    }
    if members.is_empty() {
        return FanoutStatus::Failed;
    }
    let healthy = members
        .iter()
        .filter(|status| {
            !matches!(
                status,
                FanoutMemberStatus::Failed | FanoutMemberStatus::Cancelled
            )
        })
        .count();
    if healthy == 0 {
        return FanoutStatus::Failed;
    }
    let has_broken = healthy < members.len();
    if members.iter().any(|status| {
        matches!(
            status,
            FanoutMemberStatus::Provisioning | FanoutMemberStatus::Pending
        )
    }) {
        return FanoutStatus::Provisioning;
    }
    if members
        .iter()
        .any(|status| matches!(status, FanoutMemberStatus::Interrupted))
    {
        return FanoutStatus::Interrupted;
    }
    if has_broken {
        return FanoutStatus::Partial;
    }
    if members
        .iter()
        .any(|status| matches!(status, FanoutMemberStatus::Attention))
    {
        return FanoutStatus::Attention;
    }
    if members.iter().all(|status| {
        matches!(
            status,
            FanoutMemberStatus::Done | FanoutMemberStatus::Selected
        )
    }) {
        return FanoutStatus::Ready;
    }
    FanoutStatus::Active
}

/// True when a fanout still occupies its parent, blocking a second one.
///
/// A completed, cancelled, or failed fanout releases the parent; everything
/// else — including one stuck mid-finalize — still owns it.
#[must_use]
pub fn is_active(fanout: &Fanout) -> bool {
    !matches!(
        fanout.status,
        FanoutStatus::Completed | FanoutStatus::Cancelled | FanoutStatus::Failed
    )
}

/// Destination filename when promoting a winner's scratchpad into the parent.
///
/// Keeps the original name when the parent has no file there, or when the
/// parent's file is byte-identical (re-running a promotion must be a no-op).
/// Otherwise disambiguates with the member id rather than overwriting work that
/// was already in the parent.
#[must_use]
pub fn promotion_path(
    file_path: &str,
    member_id: &str,
    existing: Option<&str>,
    contents: &str,
) -> String {
    match existing {
        None => file_path.to_string(),
        Some(current) if current == contents => file_path.to_string(),
        Some(_) => {
            let suffix = short_id(member_id);
            match file_path.rsplit_once('.') {
                Some((stem, extension)) => format!("{stem}-{suffix}.{extension}"),
                None => format!("{file_path}-{suffix}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_status, attempt_branch, derive_title, promotion_path, resolve_selector,
        CatalogAgentView, CatalogModelView,
    };
    use pragma_constants::{FanoutFailureCode, FanoutMemberStatus, FanoutStatus};

    fn catalog() -> Vec<CatalogAgentView> {
        vec![
            CatalogAgentView {
                id: "pragma.opencode".to_string(),
                runtime_agent_id: "opencode".to_string(),
                models: vec![
                    CatalogModelView {
                        id: "openai/gpt-5.6".to_string(),
                        reasoning_ids: vec!["low".to_string(), "high".to_string()],
                    },
                    CatalogModelView {
                        id: "anthropic/claude".to_string(),
                        reasoning_ids: vec!["high".to_string()],
                    },
                ],
            },
            CatalogAgentView {
                id: "pragma.opencode.beta".to_string(),
                runtime_agent_id: "opencode-beta".to_string(),
                models: vec![CatalogModelView {
                    id: "openai/gpt-5.6".to_string(),
                    reasoning_ids: vec!["max".to_string()],
                }],
            },
        ]
    }

    #[test]
    fn resolves_bare_agent_without_model_or_reasoning() {
        let resolved = resolve_selector(&catalog(), "pragma.opencode", None).expect("resolves");
        assert_eq!(resolved.catalog_agent_id, "pragma.opencode");
        assert_eq!(resolved.runtime_agent_id, "opencode");
        assert_eq!(resolved.model_id, None);
        assert_eq!(resolved.reasoning_id, None);
    }

    #[test]
    fn prefers_the_longest_agent_prefix() {
        let resolved =
            resolve_selector(&catalog(), "pragma.opencode.beta", None).expect("resolves");
        assert_eq!(resolved.catalog_agent_id, "pragma.opencode.beta");
        assert_eq!(resolved.runtime_agent_id, "opencode-beta");
    }

    #[test]
    fn resolves_a_dotted_model_id_before_treating_the_tail_as_reasoning() {
        let resolved =
            resolve_selector(&catalog(), "pragma.opencode.openai/gpt-5.6", None).expect("resolves");
        assert_eq!(resolved.model_id.as_deref(), Some("openai/gpt-5.6"));
        assert_eq!(resolved.reasoning_id, None);
    }

    #[test]
    fn resolves_model_and_trailing_reasoning() {
        let resolved = resolve_selector(&catalog(), "pragma.opencode.openai/gpt-5.6.high", None)
            .expect("resolves");
        assert_eq!(resolved.model_id.as_deref(), Some("openai/gpt-5.6"));
        assert_eq!(resolved.reasoning_id.as_deref(), Some("high"));
    }

    #[test]
    fn resolves_reasoning_only_against_the_default_model() {
        let resolved =
            resolve_selector(&catalog(), "pragma.opencode.high", None).expect("resolves");
        assert_eq!(resolved.model_id, None);
        assert_eq!(resolved.reasoning_id.as_deref(), Some("high"));
    }

    #[test]
    fn per_selector_reasoning_overrides_the_shared_default() {
        let resolved = resolve_selector(
            &catalog(),
            "pragma.opencode.openai/gpt-5.6.low",
            Some("high"),
        )
        .expect("resolves");
        assert_eq!(resolved.reasoning_id.as_deref(), Some("low"));
    }

    #[test]
    fn applies_the_shared_default_reasoning_when_the_selector_names_none() {
        let resolved =
            resolve_selector(&catalog(), "pragma.opencode", Some("high")).expect("resolves");
        assert_eq!(resolved.reasoning_id.as_deref(), Some("high"));
    }

    #[test]
    fn rejects_a_shared_default_the_resolved_model_does_not_offer() {
        let error = resolve_selector(&catalog(), "pragma.opencode.anthropic/claude", Some("low"))
            .expect_err("rejects");
        assert_eq!(error.code, FanoutFailureCode::UnknownReasoning);
    }

    #[test]
    fn rejects_an_unknown_agent_and_an_unknown_model() {
        assert_eq!(
            resolve_selector(&catalog(), "nope", None)
                .expect_err("rejects")
                .code,
            FanoutFailureCode::UnknownAgent
        );
        assert_eq!(
            resolve_selector(&catalog(), "pragma.opencode.nope", None)
                .expect_err("rejects")
                .code,
            FanoutFailureCode::UnknownModel
        );
    }

    #[test]
    fn duplicate_selectors_resolve_identically() {
        let catalog = catalog();
        let first = resolve_selector(&catalog, "pragma.opencode", Some("high")).expect("first");
        let second = resolve_selector(&catalog, "pragma.opencode", Some("high")).expect("second");
        assert_eq!(first, second);
    }

    #[test]
    fn branch_is_derived_from_ids_not_the_prompt() {
        let branch = attempt_branch("3f2a91c0-dead-beef-0000-000000000000", "m-a81c2f99");
        assert_eq!(branch, "fanout/3f2a91c0/ma81c2f9");
    }

    #[test]
    fn title_takes_the_first_non_empty_prompt_line() {
        assert_eq!(
            derive_title("\n\n  Add token refresh  \nand tests"),
            "Add token refresh"
        );
        assert!(derive_title(&"x".repeat(200)).ends_with('…'));
    }

    #[test]
    fn aggregate_status_reports_provisioning_partial_attention_and_ready() {
        use FanoutMemberStatus::{Attention, Done, Failed, Provisioning, Running};
        assert_eq!(
            aggregate_status(FanoutStatus::Provisioning, &[Provisioning, Running]),
            FanoutStatus::Provisioning
        );
        assert_eq!(
            aggregate_status(FanoutStatus::Active, &[Failed, Running]),
            FanoutStatus::Partial
        );
        assert_eq!(
            aggregate_status(FanoutStatus::Active, &[Attention, Running]),
            FanoutStatus::Attention
        );
        assert_eq!(
            aggregate_status(FanoutStatus::Active, &[Done, Done]),
            FanoutStatus::Ready
        );
        assert_eq!(
            aggregate_status(FanoutStatus::Active, &[Failed, Failed]),
            FanoutStatus::Failed
        );
    }

    #[test]
    fn aggregate_status_never_overrides_a_finalize_owned_state() {
        assert_eq!(
            aggregate_status(
                FanoutStatus::NeedsResolution,
                &[FanoutMemberStatus::Running]
            ),
            FanoutStatus::NeedsResolution
        );
        assert_eq!(
            aggregate_status(FanoutStatus::Completed, &[FanoutMemberStatus::Failed]),
            FanoutStatus::Completed
        );
    }

    #[test]
    fn promotion_keeps_the_name_when_free_or_identical_and_suffixes_on_conflict() {
        assert_eq!(
            promotion_path("a/plan.mdx", "m-1234abcd", None, "body"),
            "a/plan.mdx"
        );
        assert_eq!(
            promotion_path("a/plan.mdx", "m-1234abcd", Some("body"), "body"),
            "a/plan.mdx"
        );
        assert_eq!(
            promotion_path("a/plan.mdx", "m-1234abcd", Some("other"), "body"),
            "a/plan-m1234abc.mdx"
        );
    }
}
