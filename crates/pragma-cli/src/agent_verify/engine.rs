use std::time::Duration;

use pragma_constants::{AgentAttentionKind, AgentMessage, AgentStatus, QuestionOption};

use super::events::{EventMatch, Ledger, VerifyEvent};
use super::gateway::{LaunchResult, VerifyApi};

/// Shared immutable inputs for scenario execution.
pub struct ScenarioCtx<'a> {
    pub api: &'a dyn VerifyApi,
    pub ledger: &'a Ledger,
    pub project_id: &'a str,
    pub worktree_id: &'a str,
    pub catalog_agent_id: &'a str,
    pub plugin_id: &'a str,
    pub runtime_agent_id: &'a str,
    pub model_id: Option<&'a str>,
    /// Raw model command from `--pick-model-cmd`; overrides `model_id` at launch.
    pub model_cmd: Option<&'a str>,
    pub timeout: Duration,
    pub abort_input: &'a [u8],
}

impl<'a> ScenarioCtx<'a> {
    /// Launches a fresh agent session with scenario prompt.
    pub fn launch(&self, prompt: &str) -> Result<ScenarioSession<'a>, String> {
        let cursor = self.ledger.cursor();
        let launch = self.api.launch(
            self.project_id,
            self.worktree_id,
            self.catalog_agent_id,
            self.model_id,
            self.model_cmd,
            prompt,
        )?;
        Ok(ScenarioSession {
            api: self.api,
            ledger: self.ledger,
            agent_id: self.runtime_agent_id,
            timeout: self.timeout,
            launch,
            start_cursor: cursor,
            cursor,
            active: true,
        })
    }
}

/// Attention details captured from a scoped agent status event.
pub struct Attention {
    pub agent: String,
    pub command: Option<String>,
    pub question: Option<String>,
    pub options: Vec<QuestionOption>,
    pub request_id: String,
}

/// Fresh session with cursor-scoped event helpers and kill-on-drop teardown.
pub struct ScenarioSession<'a> {
    api: &'a dyn VerifyApi,
    ledger: &'a Ledger,
    agent_id: &'a str,
    timeout: Duration,
    launch: LaunchResult,
    start_cursor: usize,
    cursor: usize,
    active: bool,
}

impl ScenarioSession<'_> {
    pub fn tab_id(&self) -> &str {
        &self.launch.tab_id
    }

    pub fn worktree_id(&self) -> &str {
        &self.launch.worktree_id
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn await_running(&mut self) -> Result<(), String> {
        self.await_status(|status| status == AgentStatus::Running)
            .map(|_| ())
            .map_err(|error| {
                format!("no running status; prompt prefill may have missed TUI: {error}")
            })
    }

    pub fn await_settled(&mut self) -> Result<AgentStatus, String> {
        self.await_status(|status| matches!(status, AgentStatus::Done | AgentStatus::Cleared))
    }

    /// Waits for a session-name report WITHOUT advancing the session cursor
    /// (the name often rides on — or arrives beside — status events the
    /// scenario still needs), returning the reported name.
    pub fn await_session_name(&mut self) -> Result<String, String> {
        let found = self.wait_peek(|event| {
            matches!(
                event,
                VerifyEvent::Agent { session_name: Some(name), .. } if !name.trim().is_empty()
            )
        })?;
        let VerifyEvent::Agent {
            session_name: Some(name),
            ..
        } = found.event
        else {
            return Err("expected session name event".to_string());
        };
        Ok(name)
    }

    pub fn await_attention(&mut self, kind: AgentAttentionKind) -> Result<Attention, String> {
        let found = self.wait(|event| {
            matches!(
                event,
                VerifyEvent::Agent {
                    status: Some(AgentStatus::Attention),
                    attention_kind: Some(found),
                    ..
                } if *found == kind
            )
        })?;
        let VerifyEvent::Agent {
            agent,
            attention_kind: Some(_),
            command,
            question,
            options,
            request_id: Some(request_id),
            ..
        } = found.event
        else {
            return Err("attention event omitted kind or requestId".to_string());
        };
        Ok(Attention {
            agent,
            command,
            question,
            options: options.unwrap_or_default(),
            request_id,
        })
    }

    /// Waits for a non-empty assistant message WITHOUT advancing the session
    /// cursor. Stop-hook reporters may emit the reply right after their done
    /// status; consuming events up to the message would skip that done event
    /// and make a later `await_settled` time out even though the turn settled.
    pub fn await_assistant_message(&mut self) -> Result<AgentMessage, String> {
        let found = self.wait_peek(|event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if matches!(message.role, pragma_constants::AgentMessageRole::Assistant)
                    && message.text.as_ref().is_some_and(|text| !text.trim().is_empty()))
        })?;
        let VerifyEvent::AgentMessage { message } = found.event else {
            return Err("expected agentMessage".to_string());
        };
        Ok(message)
    }

    /// Waits for an assistant message containing `needle`, without advancing
    /// the cursor (see [`Self::await_assistant_message`] for why). Covers both
    /// free-text delivery paths: an in-turn reply, or the reply of the
    /// follow-up turn a fallback-interjecting watcher starts after aborting
    /// the response (Codex's "None of the above" secondary path).
    pub fn await_assistant_message_containing(&mut self, needle: &str) -> Result<(), String> {
        self.wait_peek(|event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if matches!(message.role, pragma_constants::AgentMessageRole::Assistant)
                    && message.text.as_ref().is_some_and(|text| text.contains(needle)))
        })?;
        Ok(())
    }

    pub fn await_subagents(&mut self, minimum: u64) -> Result<(), String> {
        self.wait(|event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if message.sub_agents_active >= minimum)
        })?;
        Ok(())
    }

    pub fn await_decision_echo(&mut self, request_id: &str, approved: bool) -> Result<(), String> {
        self.wait(|event| {
            matches!(event, VerifyEvent::AgentDecision { decision }
                if decision.request_id == request_id && decision.approved == approved)
        })?;
        Ok(())
    }

    pub fn await_answer_echo(
        &mut self,
        request_id: &str,
        answer: Option<&str>,
    ) -> Result<(), String> {
        self.wait(|event| {
            matches!(event, VerifyEvent::AgentAnswer { answer: event }
                if event.request_id == request_id
                    && event.dismissed == answer.is_none()
                    && (answer.is_none() || event.answer.as_deref() == answer))
        })?;
        Ok(())
    }

    pub fn scoped_events_since_cursor(&self) -> Vec<VerifyEvent> {
        self.ledger
            .events_since(self.cursor)
            .into_iter()
            .filter(|event| self.is_scoped(event))
            .collect()
    }

    pub fn scoped_events_since_start(&self) -> Vec<VerifyEvent> {
        self.ledger
            .events_since(self.start_cursor)
            .into_iter()
            .filter(|event| self.is_scoped(event))
            .collect()
    }

    pub fn write_abort(&self, bytes: &[u8]) -> Result<(), String> {
        self.api.write_input(self.tab_id(), bytes)
    }

    pub fn interrupt(&self, agent: &str) -> Result<(), String> {
        self.api.interrupt(agent, self.worktree_id(), self.tab_id())
    }

    pub fn kill(&mut self) -> Result<(), String> {
        self.api.kill_session(self.tab_id())?;
        self.active = false;
        Ok(())
    }

    fn await_status(
        &mut self,
        predicate: impl Fn(AgentStatus) -> bool,
    ) -> Result<AgentStatus, String> {
        let found = self.wait(
            |event| matches!(event, VerifyEvent::Agent { status: Some(status), .. } if predicate(*status)),
        )?;
        let VerifyEvent::Agent {
            status: Some(status),
            ..
        } = found.event
        else {
            return Err("expected agent status".to_string());
        };
        Ok(status)
    }

    fn wait(&mut self, predicate: impl FnMut(&VerifyEvent) -> bool) -> Result<EventMatch, String> {
        let found = self.wait_peek(predicate)?;
        self.cursor = found.cursor;
        Ok(found)
    }

    /// Like `wait`, but leaves the session cursor untouched so intervening
    /// events stay visible to the next await.
    fn wait_peek(&self, predicate: impl FnMut(&VerifyEvent) -> bool) -> Result<EventMatch, String> {
        let tab_id = self.launch.tab_id.clone();
        let worktree_id = self.launch.worktree_id.clone();
        let agent_id = self.agent_id;
        let mut predicate = predicate;
        self.ledger.wait_for(self.cursor, self.timeout, |event| {
            scoped(event, &worktree_id, &tab_id, agent_id) && predicate(event)
        })
    }

    fn is_scoped(&self, event: &VerifyEvent) -> bool {
        scoped(event, self.worktree_id(), self.tab_id(), self.agent_id)
    }
}

impl Drop for ScenarioSession<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.api.kill_session(self.tab_id());
        }
    }
}

fn scoped(event: &VerifyEvent, worktree_id: &str, tab_id: &str, agent_id: &str) -> bool {
    let (event_worktree, event_tab, event_agent) = match event {
        VerifyEvent::Agent {
            worktree_id,
            tab_id,
            agent,
            ..
        } => (worktree_id, tab_id, agent),
        VerifyEvent::AgentMessage { message } => {
            (&message.worktree_id, &message.tab_id, &message.agent)
        }
        VerifyEvent::AgentDecision { decision } => {
            (&decision.worktree_id, &decision.tab_id, &decision.agent)
        }
        VerifyEvent::AgentAnswer { answer } => (&answer.worktree_id, &answer.tab_id, &answer.agent),
        VerifyEvent::AgentInput { input } => (&input.worktree_id, &input.tab_id, &input.agent),
        VerifyEvent::AgentInterrupt { interrupt } => {
            (&interrupt.worktree_id, &interrupt.tab_id, &interrupt.agent)
        }
        VerifyEvent::Ready | VerifyEvent::Snapshot { .. } | VerifyEvent::Delta { .. } => {
            return false;
        }
    };
    event_worktree == worktree_id && event_tab == tab_id && event_agent == agent_id
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::agent_verify::gateway::LaunchResult;

    struct StubApi;

    impl crate::agent_verify::gateway::VerifyApi for StubApi {
        fn catalog(&self) -> Result<pragma_constants::AgentCatalog, String> {
            Err("unused".to_string())
        }
        fn asset_exists(&self, _hash: &str) -> Result<(), String> {
            Ok(())
        }
        fn workspace_snapshot(&self) -> Result<pragma_constants::WorkspaceSnapshot, String> {
            Err("unused".to_string())
        }
        fn launch(
            &self,
            _project_id: &str,
            _worktree_id: &str,
            _agent_id: &str,
            _model_id: Option<&str>,
            _model_cmd: Option<&str>,
            _prompt: &str,
        ) -> Result<LaunchResult, String> {
            Ok(LaunchResult {
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
            })
        }
        fn answer(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
            _request_id: &str,
            _answer: Option<&str>,
        ) -> Result<(), String> {
            Ok(())
        }
        fn decide(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
            _request_id: &str,
            _approved: bool,
        ) -> Result<(), String> {
            Ok(())
        }
        fn interrupt(&self, _agent: &str, _worktree_id: &str, _tab_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn write_input(&self, _session_id: &str, _bytes: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn kill_session(&self, _session_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn usage_limits(&self, _plugin_id: &str) -> Result<serde_json::Value, String> {
            Err("unused".to_string())
        }
        fn event_reader(&self) -> Result<Box<dyn std::io::BufRead + Send>, String> {
            Err("unused".to_string())
        }
    }

    fn session<'a>(api: &'a StubApi, ledger: &'a Ledger, agent_id: &'a str) -> ScenarioSession<'a> {
        ScenarioSession {
            api,
            ledger,
            agent_id,
            timeout: Duration::from_millis(500),
            launch: LaunchResult {
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
            },
            start_cursor: 0,
            cursor: 0,
            active: false,
        }
    }

    fn agent_status_line(status: &str) -> String {
        format!(
            r#"{{"type":"agent","worktreeId":"w","tabId":"t","agent":"a","status":"{status}","attentionKind":null,"command":null,"question":null,"options":null,"requestId":null}}"#
        )
    }

    /// Stop-hook reporters emit the assistant reply right after `stopped`;
    /// awaiting the message must not consume the earlier done status.
    #[test]
    fn assistant_message_after_done_still_settles() {
        let ledger = Ledger::default();
        for line in [
            agent_status_line("running"),
            agent_status_line("done"),
            r##"{"type":"agentMessage","message":{"agent":"a","worktreeId":"w","tabId":"t","id":"m1","role":"assistant","text":"# Reply","subAgentsActive":0,"ts":1}}"##.to_string(),
        ] {
            ledger.ingest_line(&line);
        }
        let api = StubApi;
        let mut session = session(&api, &ledger, "a");
        session.await_running().expect("running");
        let message = session
            .await_assistant_message()
            .expect("assistant message");
        assert_eq!(message.text.as_deref(), Some("# Reply"));
        assert_eq!(session.await_settled().expect("settled"), AgentStatus::Done);
    }

    /// Fallback-interject free-text delivery (Codex "None of the above"):
    /// the abort settles the first turn before the follow-up turn carries the
    /// marker. Awaiting the marker message must not consume that first settle.
    #[test]
    fn marker_in_follow_up_turn_still_settles() {
        let ledger = Ledger::default();
        for line in [
            agent_status_line("running"),
            agent_status_line("cleared"),
            agent_status_line("running"),
            r#"{"type":"agentMessage","message":{"agent":"a","worktreeId":"w","tabId":"t","id":"m1","role":"assistant","text":"marker-echo","subAgentsActive":0,"ts":1}}"#.to_string(),
            agent_status_line("done"),
        ] {
            ledger.ingest_line(&line);
        }
        let api = StubApi;
        let mut session = session(&api, &ledger, "a");
        session.await_running().expect("running");
        session
            .await_assistant_message_containing("marker-echo")
            .expect("marker message");
        assert_eq!(
            session.await_settled().expect("settled"),
            AgentStatus::Cleared
        );
    }

    /// The message-before-done order (streaming reporters) must keep working.
    #[test]
    fn assistant_message_before_done_still_settles() {
        let ledger = Ledger::default();
        for line in [
            agent_status_line("running"),
            r##"{"type":"agentMessage","message":{"agent":"a","worktreeId":"w","tabId":"t","id":"m1","role":"assistant","text":"# Reply","subAgentsActive":0,"ts":1}}"##.to_string(),
            agent_status_line("done"),
        ] {
            ledger.ingest_line(&line);
        }
        let api = StubApi;
        let mut session = session(&api, &ledger, "a");
        session.await_running().expect("running");
        session
            .await_assistant_message()
            .expect("assistant message");
        assert_eq!(session.await_settled().expect("settled"), AgentStatus::Done);
    }
}
