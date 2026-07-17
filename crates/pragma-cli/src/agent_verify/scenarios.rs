use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use pragma_constants::{AgentAttentionKind, AgentStatus};

use super::engine::ScenarioCtx;
use super::events::VerifyEvent;
use super::prompts::Prompts;

/// Scenario execution result.
pub enum Outcome {
    Passed,
    Skipped(String),
}

/// One executable verification scenario.
pub struct ScenarioDef {
    pub id: &'static str,
    pub name: &'static str,
    pub slow: bool,
    pub run: fn(&ScenarioCtx<'_>, &Prompts) -> Result<Outcome, String>,
}

/// Ordered scenario table. Stream integrity must remain last.
pub fn definitions() -> &'static [ScenarioDef] {
    &[
        ScenarioDef {
            id: "basic-reply",
            name: "basic reply",
            slow: false,
            run: basic_reply,
        },
        ScenarioDef {
            id: "question-answer",
            name: "question answer",
            slow: false,
            run: question_answer,
        },
        ScenarioDef {
            id: "question-dismiss",
            name: "question dismiss",
            slow: false,
            run: question_dismiss,
        },
        ScenarioDef {
            id: "question-free-text",
            name: "question free text",
            slow: false,
            run: question_free_text,
        },
        ScenarioDef {
            id: "command-allow",
            name: "command allow",
            slow: false,
            run: command_allow,
        },
        ScenarioDef {
            id: "command-deny",
            name: "command deny",
            slow: false,
            run: command_deny,
        },
        ScenarioDef {
            id: "decision-timeout",
            name: "decision timeout",
            slow: true,
            run: decision_timeout,
        },
        ScenarioDef {
            id: "subagent",
            name: "parallel sub-agents",
            slow: false,
            run: subagent,
        },
        ScenarioDef {
            id: "abort-mid-run",
            name: "abort mid-run",
            slow: false,
            run: abort_mid_run,
        },
        ScenarioDef {
            id: "interrupt-event",
            name: "interrupt event",
            slow: false,
            run: interrupt_event,
        },
        ScenarioDef {
            id: "abort-mid-question",
            name: "abort mid-question",
            slow: false,
            run: abort_mid_question,
        },
        ScenarioDef {
            id: "abort-mid-approval",
            name: "abort mid-approval",
            slow: false,
            run: abort_mid_approval,
        },
        ScenarioDef {
            id: "crash-exit",
            name: "crash/exit settle",
            slow: false,
            run: crash_exit,
        },
        ScenarioDef {
            id: "usage-limits",
            name: "usage limits",
            slow: false,
            run: usage_limits,
        },
        ScenarioDef {
            id: "stream-integrity",
            name: "stream integrity",
            slow: false,
            run: stream_integrity,
        },
    ]
}

fn basic_reply(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("basic-reply")?)?;
    session.await_running()?;
    session.await_assistant_message()?;
    require_done(session.await_settled()?)?;
    Ok(Outcome::Passed)
}

fn question_answer(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("question-answer")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Question)?;
    validate_question(&attention, "Choose Red or Blue?", &["Red", "Blue"])?;
    let answer = attention.options[0].label.clone();
    ctx.api.answer(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        Some(&answer),
    )?;
    session.await_answer_echo(&attention.request_id, Some(&answer))?;
    require_done(session.await_settled()?)?;
    Ok(Outcome::Passed)
}

fn question_dismiss(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("question-dismiss")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Question)?;
    validate_question(&attention, "Choose Red or Blue?", &["Red", "Blue"])?;
    let wrong_id = format!("{}-wrong", attention.request_id);
    ctx.api.answer(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &wrong_id,
        None,
    )?;
    thread::sleep(Duration::from_secs(2));
    if session.scoped_events_since_cursor().iter().any(|event| {
        matches!(event, VerifyEvent::Agent { status, .. } if *status != AgentStatus::Attention)
    }) {
        return Err("wrong requestId cleared question attention".to_string());
    }
    ctx.api.answer(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        None,
    )?;
    session.await_answer_echo(&attention.request_id, None)?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn question_free_text(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    const MARKER: &str = "pragma-verify-free-text";
    let mut session = ctx.launch(prompts.get("question-free-text")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Question)?;
    validate_question(
        &attention,
        "What verification marker should I use?",
        &["Alpha", "Beta"],
    )?;
    if attention
        .options
        .iter()
        .any(|option| option.label == MARKER)
    {
        return Err("free-text marker unexpectedly matched a listed option".to_string());
    }
    ctx.api.answer(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        Some(MARKER),
    )?;
    session.await_answer_echo(&attention.request_id, Some(MARKER))?;
    // Primary path: the TUI's custom-answer editor delivers the marker inside
    // the same turn. Secondary path: a TUI without a free-text editor (Codex)
    // selects its fallback row ("None of the above"), aborts the response, and
    // resubmits the answer as an `Answer to question ...` follow-up prompt —
    // the marker then arrives in that follow-up turn. Both paths must end with
    // the agent echoing the marker back, proving the answer reached it.
    session.await_assistant_message_containing(MARKER)?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn command_allow(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("command-allow")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Command)?;
    if !attention
        .command
        .as_deref()
        .is_some_and(|command| command.contains("pragma-verify-approval"))
    {
        return Err("command attention omitted expected command".to_string());
    }
    ctx.api.decide(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        true,
    )?;
    session.await_decision_echo(&attention.request_id, true)?;
    session.await_running()?;
    require_done(session.await_settled()?)?;
    Ok(Outcome::Passed)
}

fn command_deny(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("command-deny")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Command)?;
    let wrong_id = format!("{}-wrong", attention.request_id);
    ctx.api.decide(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &wrong_id,
        false,
    )?;
    thread::sleep(Duration::from_millis(500));
    if session.scoped_events_since_cursor().iter().any(|event| {
        matches!(event, VerifyEvent::Agent { status, .. } if *status != AgentStatus::Attention)
    }) {
        return Err("wrong requestId cleared command attention".to_string());
    }
    ctx.api.decide(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        false,
    )?;
    session.await_decision_echo(&attention.request_id, false)?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn decision_timeout(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("decision-timeout")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Command)?;
    if attention.request_id.is_empty() {
        return Err("timeout attention omitted stable requestId".to_string());
    }
    session.await_settled().map_err(|_| {
        "approval hook did not fall back before --step-timeout; increase it above host hook timeout"
            .to_string()
    })?;
    Ok(Outcome::Passed)
}

fn subagent(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("subagent")?)?;
    session.await_running()?;
    session.await_subagents(2)?;
    require_done(session.await_settled()?)?;
    Ok(Outcome::Passed)
}

fn abort_mid_run(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("abort-mid-run")?)?;
    session.await_running()?;
    session.write_abort(ctx.abort_input)?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn interrupt_event(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("interrupt-event")?)?;
    session.await_running()?;
    session.interrupt(ctx.runtime_agent_id)?;
    let interrupt = ctx.ledger.wait_for(session.cursor(), ctx.timeout, |event| {
        matches!(event, VerifyEvent::AgentInterrupt { interrupt }
            if interrupt.tab_id == session.tab_id() && interrupt.worktree_id == session.worktree_id())
    })?;
    if !matches!(interrupt.event, VerifyEvent::AgentInterrupt { .. }) {
        return Err("interrupt fan-out missing".to_string());
    }
    if session.await_settled().is_ok() {
        Ok(Outcome::Passed)
    } else {
        session.write_abort(ctx.abort_input)?;
        session.await_settled()?;
        Ok(Outcome::Skipped(
            "interrupt fan-out arrived but no decision-handling watcher settled session"
                .to_string(),
        ))
    }
}

fn abort_mid_question(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("abort-mid-question")?)?;
    session.await_running()?;
    let attention = session.await_attention(AgentAttentionKind::Question)?;
    session.write_abort(ctx.abort_input)?;
    session.await_settled()?;
    ctx.api.answer(
        &attention.agent,
        session.worktree_id(),
        session.tab_id(),
        &attention.request_id,
        Some("late-answer"),
    )?;
    thread::sleep(Duration::from_millis(300));
    if session.scoped_events_since_cursor().iter().any(|event| {
        matches!(
            event,
            VerifyEvent::Agent {
                status: AgentStatus::Attention,
                ..
            }
        )
    }) {
        return Err("late answer resurrected attention".to_string());
    }
    Ok(Outcome::Passed)
}

fn abort_mid_approval(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("abort-mid-approval")?)?;
    session.await_running()?;
    session.await_attention(AgentAttentionKind::Command)?;
    session.write_abort(ctx.abort_input)?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn crash_exit(ctx: &ScenarioCtx<'_>, prompts: &Prompts) -> Result<Outcome, String> {
    let mut session = ctx.launch(prompts.get("crash-exit")?)?;
    session.await_running()?;
    session.kill()?;
    session.await_settled()?;
    Ok(Outcome::Passed)
}

fn usage_limits(ctx: &ScenarioCtx<'_>, _prompts: &Prompts) -> Result<Outcome, String> {
    let value = ctx.api.usage_limits(ctx.plugin_id)?;
    let providers = value
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "usageLimits response omitted providers[]".to_string())?;
    if providers.is_empty() {
        return Ok(Outcome::Skipped(
            "plugin defines no usage-limit provider".to_string(),
        ));
    }
    for provider in providers {
        if provider.get("pluginId").and_then(serde_json::Value::as_str) != Some(ctx.plugin_id)
            || provider
                .get("providerId")
                .and_then(serde_json::Value::as_str)
                .is_none_or(str::is_empty)
            || provider
                .get("title")
                .and_then(serde_json::Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Err("usageLimits provider metadata is malformed".to_string());
        }
        validate_usage_result(provider.get("result").unwrap_or(&serde_json::Value::Null))?;
    }
    Ok(Outcome::Passed)
}

fn stream_integrity(ctx: &ScenarioCtx<'_>, _prompts: &Prompts) -> Result<Outcome, String> {
    let errors = ctx.ledger.schema_errors();
    if !errors.is_empty() {
        return Err(format!("event schema errors: {}", errors.join(" | ")));
    }
    if ctx.ledger.ready_count() == 0 {
        return Err("agent stream emitted no ready heartbeat".to_string());
    }
    let mut timestamps: HashMap<String, u64> = HashMap::new();
    for event in ctx.ledger.events_since(0) {
        match event {
            VerifyEvent::AgentMessage { ref message } => {
                if let Some(previous) = timestamps.insert(message.id.clone(), message.ts) {
                    if message.ts < previous {
                        return Err(format!("message {} timestamp moved backward", message.id));
                    }
                }
            }
            VerifyEvent::Agent {
                status: AgentStatus::Attention,
                attention_kind: Some(AgentAttentionKind::Question),
                question,
                request_id,
                ..
            } if question.as_deref().is_none_or(str::is_empty) || request_id.is_none() => {
                return Err("question attention omitted question/requestId".to_string());
            }
            VerifyEvent::Agent {
                status: AgentStatus::Attention,
                attention_kind: Some(AgentAttentionKind::Command),
                command,
                request_id,
                ..
            } if command.as_deref().is_none_or(str::is_empty) || request_id.is_none() => {
                return Err("command attention omitted command/requestId".to_string());
            }
            _ => {}
        }
    }
    Ok(Outcome::Passed)
}

fn require_done(status: AgentStatus) -> Result<(), String> {
    if status == AgentStatus::Done {
        Ok(())
    } else {
        Err(format!("expected done, got {status:?}"))
    }
}

fn validate_question(
    attention: &super::engine::Attention,
    expected_question: &str,
    expected_options: &[&str],
) -> Result<(), String> {
    if attention.question.as_deref().map(str::trim) != Some(expected_question) {
        return Err(format!(
            "question attention text mismatch: expected {expected_question:?}, got {:?}",
            attention.question
        ));
    }
    let labels: Vec<&str> = attention
        .options
        .iter()
        .map(|option| {
            option
                .label
                .trim()
                .strip_suffix(" (Recommended)")
                .unwrap_or(option.label.trim())
        })
        .collect();
    if labels != expected_options {
        return Err(format!(
            "question attention options mismatch: expected {expected_options:?}, got {labels:?}"
        ));
    }
    Ok(())
}

fn validate_usage_result(value: &serde_json::Value) -> Result<(), String> {
    match value.get("status").and_then(serde_json::Value::as_str) {
        Some("ready") => {
            value
                .get("observedAt")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "ready usage provider omitted observedAt".to_string())?;
            let limits = value
                .get("limits")
                .and_then(serde_json::Value::as_array)
                .filter(|limits| !limits.is_empty())
                .ok_or_else(|| "ready usage provider returned no limits".to_string())?;
            for limit in limits {
                validate_limit(limit)?;
            }
            if let Some(summary) = value.get("summary") {
                validate_limit(summary)?;
            }
            Ok(())
        }
        Some("unavailable") => {
            let reason = value.get("reason").and_then(serde_json::Value::as_str);
            let message = value.get("message").and_then(serde_json::Value::as_str);
            if matches!(
                reason,
                Some("not-configured" | "authentication-required" | "unsupported")
            ) && message.is_some_and(|message| !message.trim().is_empty())
            {
                Ok(())
            } else {
                Err("unavailable usage provider returned invalid reason/message".to_string())
            }
        }
        _ => Err("usage provider returned unknown status".to_string()),
    }
}

fn validate_limit(limit: &serde_json::Value) -> Result<(), String> {
    if limit
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_none_or(str::is_empty)
        || limit
            .get("title")
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err("usage limit omitted id/title".to_string());
    }
    limit
        .get("used")
        .and_then(serde_json::Value::as_f64)
        .filter(|used| used.is_finite() && *used >= 0.0)
        .ok_or_else(|| "usage limit has invalid used value".to_string())?;
    let limit_value = limit
        .get("limit")
        .ok_or_else(|| "usage limit omitted limit value".to_string())?;
    if !limit_value.is_null()
        && limit_value
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value <= 0.0)
    {
        return Err("usage limit has invalid limit value".to_string());
    }
    if limit.get("resetsInMs").is_some_and(|value| {
        value
            .as_f64()
            .is_none_or(|value| !value.is_finite() || value < 0.0)
    }) {
        return Err("usage limit has invalid reset duration".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use pragma_constants::QuestionOption;

    use super::{validate_question, validate_usage_result};
    use crate::agent_verify::engine::Attention;

    #[test]
    fn validates_ready_and_unavailable_usage_results() {
        assert!(validate_usage_result(&json!({
            "status": "ready",
            "observedAt": 1,
            "limits": [{ "id": "daily", "title": "Daily", "used": 1, "limit": 10 }]
        }))
        .is_ok());
        assert!(validate_usage_result(&json!({
            "status": "unavailable",
            "reason": "authentication-required",
            "message": "Sign in"
        }))
        .is_ok());
        assert!(validate_usage_result(&json!({ "status": "ready", "limits": [] })).is_err());
    }

    #[test]
    fn validates_exact_question_report() {
        let attention = Attention {
            agent: "agent".to_string(),
            command: None,
            question: Some("Choose Red or Blue?".to_string()),
            options: vec![
                QuestionOption {
                    label: "Red (Recommended)".to_string(),
                    description: None,
                },
                QuestionOption {
                    label: "Blue".to_string(),
                    description: None,
                },
            ],
            request_id: "request".to_string(),
        };
        assert!(validate_question(&attention, "Choose Red or Blue?", &["Red", "Blue"]).is_ok());
        assert!(validate_question(&attention, "Different?", &["Red", "Blue"]).is_err());
    }
}
