use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{AgentAttentionKind, AgentMessage, AgentStatus, QuestionOption};

use super::events::{EventMatch, Ledger, VerifyEvent};
use super::gateway::{LaunchResult, LaunchSpec, VerifyApi};

/// Extra window kept open after a settle status for events that legitimately
/// ride behind it (stop-hook reporters emit the assistant reply after `done`).
/// A new `running` status re-opens the full window for follow-up turns.
const SETTLE_GRACE: Duration = Duration::from_secs(10);

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
    /// One total budget shared by every wait within a fresh session attempt.
    pub attempt_timeout: Duration,
    pub abort_input: &'a [u8],
    /// Launch server-side without opening a desktop tab.
    pub headless: bool,
    /// The agent prefill uses plain typing instead of bracketed paste, from
    /// the catalog launch config; mirrored by the prefill retry.
    pub prefill_plain: bool,
    /// Submit bytes the prefill retry sends after retyping the prompt.
    pub prefill_submit: &'a str,
    /// Tab ids launched by this scenario, so failure evidence can be scoped to
    /// its own sessions when scenarios run concurrently.
    pub launched_tabs: Mutex<Vec<String>>,
    /// Every session launched by this verify run, for final status cleanup.
    pub all_launched_tabs: &'a Mutex<Vec<LaunchResult>>,
}

impl<'a> ScenarioCtx<'a> {
    /// Launches a fresh agent session with scenario prompt.
    pub fn launch(&self, prompt: &str) -> Result<ScenarioSession<'a>, String> {
        let cursor = self.ledger.cursor();
        let launch = self.api.launch(&LaunchSpec {
            project_id: self.project_id,
            worktree_id: self.worktree_id,
            agent_id: self.catalog_agent_id,
            model_id: self.model_id,
            model_cmd: self.model_cmd,
            headless: self.headless,
            prompt,
        })?;
        if let Ok(mut tabs) = self.launched_tabs.lock() {
            tabs.push(launch.tab_id.clone());
        }
        if let Ok(mut tabs) = self.all_launched_tabs.lock() {
            tabs.push(launch.clone());
        }
        // Headless replies only after PTY spawn. Headed replies precede the
        // frontend spawn, so probing those sessions here would race by design.
        if self.headless {
            if let Err(error) = self.api.write_input(&launch.tab_id, &[]) {
                return Err(format!("terminal failed to launch: {error}"));
            }
        }
        Ok(ScenarioSession {
            api: self.api,
            ledger: self.ledger,
            agent_id: self.runtime_agent_id,
            deadline: Instant::now() + self.attempt_timeout,
            settle_grace: SETTLE_GRACE,
            launch,
            start_cursor: cursor,
            cursor,
            active: true,
            prompt: prompt.to_string(),
            prefill_plain: self.prefill_plain,
            prefill_submit: self.prefill_submit.to_string(),
        })
    }
}

/// Attention details captured from a scoped agent status event.
#[derive(Debug)]
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
    deadline: Instant,
    /// Settle fail-fast window (see [`SETTLE_GRACE`]); a field so tests can
    /// shrink it.
    settle_grace: Duration,
    launch: LaunchResult,
    start_cursor: usize,
    cursor: usize,
    active: bool,
    /// Launch prompt, kept for the one-shot prefill retry in
    /// [`Self::await_running`].
    prompt: String,
    prefill_plain: bool,
    prefill_submit: String,
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
        // Give parallel cold starts at most 20 seconds before one recovery
        // write. Repeating the prompt again could create duplicate turns when
        // the TUI accepted it but status reporting is merely delayed.
        let first = (self.remaining_timeout()? / 2).min(Duration::from_secs(20));
        if self
            .await_status_within(first, |status| status == AgentStatus::Running)
            .is_ok()
        {
            return Ok(());
        }
        self.retype_prompt()?;
        let remaining = self.remaining_timeout()?;
        self.await_status_within(remaining, |status| status == AgentStatus::Running)
            .map(|_| ())
            .map_err(|error| format!("no running status even after a prefill retry: {error}"))
    }

    /// Retypes the launch prompt into the session (mirroring the host's
    /// prefill mode) and submits it.
    fn retype_prompt(&self) -> Result<(), String> {
        let body = if self.prefill_plain {
            self.prompt.clone()
        } else {
            format!("\u{1b}[200~{}\u{1b}[201~", self.prompt)
        };
        self.api.write_input(self.tab_id(), body.as_bytes())?;
        thread::sleep(Duration::from_millis(200));
        self.api
            .write_input(self.tab_id(), self.prefill_submit.as_bytes())
    }

    pub fn await_settled(&mut self) -> Result<AgentStatus, String> {
        self.await_status(|status| matches!(status, AgentStatus::Done | AgentStatus::Cleared))
    }

    /// Waits for a session-name report WITHOUT advancing the session cursor
    /// (the name often rides on — or arrives beside — status events the
    /// scenario still needs), returning the reported name.
    pub fn await_session_name(&mut self) -> Result<String, String> {
        let found = self.wait_peek_until_settled("a session-name report", |event| {
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
        let what = match kind {
            AgentAttentionKind::Question => "question attention",
            AgentAttentionKind::Command => "command attention",
        };
        let found = self.wait_until_settled(what, |event| {
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
        let found = self.wait_peek_until_settled("an assistant message", |event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if matches!(message.role, pragma_constants::AgentMessageRole::Assistant)
                    && message.text.as_ref().is_some_and(|text| !text.trim().is_empty()))
        })?;
        let VerifyEvent::AgentMessage { message } = found.event else {
            return Err("expected agentMessage".to_string());
        };
        Ok(message)
    }

    pub fn await_assistant_message_matching(
        &mut self,
        predicate: impl Fn(&str) -> bool,
    ) -> Result<AgentMessage, String> {
        let found = self.wait_peek_until_settled("a matching assistant message", |event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if matches!(message.role, pragma_constants::AgentMessageRole::Assistant)
                    && message.text.as_deref().is_some_and(&predicate))
        })?;
        let VerifyEvent::AgentMessage { message } = found.event else {
            unreachable!("assistant message predicate guarantees message event")
        };
        Ok(message)
    }

    /// Waits for an assistant message containing `needle`, without advancing
    /// the cursor (see [`Self::await_assistant_message`] for why). Covers both
    /// free-text delivery paths: an in-turn reply, or the reply of the
    /// follow-up turn a fallback-interjecting watcher starts after aborting
    /// the response (Codex's "None of the above" secondary path).
    pub fn await_assistant_message_containing(&mut self, needle: &str) -> Result<(), String> {
        self.wait_peek_until_settled("an assistant message with the marker", |event| {
            matches!(event, VerifyEvent::AgentMessage { message }
                if matches!(message.role, pragma_constants::AgentMessageRole::Assistant)
                    && message.text.as_ref().is_some_and(|text| text.contains(needle)))
        })?;
        Ok(())
    }

    pub fn await_subagents(&mut self, minimum: u64) -> Result<(), String> {
        self.wait_until_settled("parallel sub-agent activity", |event| {
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
        self.await_status_within(self.remaining_timeout()?, predicate)
    }

    fn await_status_within(
        &mut self,
        timeout: Duration,
        predicate: impl Fn(AgentStatus) -> bool,
    ) -> Result<AgentStatus, String> {
        let found = self.wait_within(
            timeout,
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

    /// Like `wait`, but with an explicit timeout window.
    fn wait_within(
        &mut self,
        timeout: Duration,
        predicate: impl FnMut(&VerifyEvent) -> bool,
    ) -> Result<EventMatch, String> {
        let found = self.wait_peek_within(timeout, predicate)?;
        self.cursor = found.cursor;
        Ok(found)
    }

    /// Like `wait`, but leaves the session cursor untouched so intervening
    /// events stay visible to the next await.
    fn wait_peek(&self, predicate: impl FnMut(&VerifyEvent) -> bool) -> Result<EventMatch, String> {
        self.wait_peek_within(self.remaining_timeout()?, predicate)
    }

    fn wait_peek_within(
        &self,
        timeout: Duration,
        predicate: impl FnMut(&VerifyEvent) -> bool,
    ) -> Result<EventMatch, String> {
        let tab_id = self.launch.tab_id.clone();
        let worktree_id = self.launch.worktree_id.clone();
        let agent_id = self.agent_id;
        let mut predicate = predicate;
        self.ledger.wait_for(self.cursor, timeout, |event| {
            scoped(event, &worktree_id, &tab_id, agent_id) && predicate(event)
        })
    }

    /// Like `wait`, but fails fast once the session settles: `what` never
    /// arriving is decided `SETTLE_GRACE` after a done/cleared status instead
    /// of burning the whole step timeout.
    fn wait_until_settled(
        &mut self,
        what: &str,
        predicate: impl FnMut(&VerifyEvent) -> bool,
    ) -> Result<EventMatch, String> {
        let found = self.wait_peek_until_settled(what, predicate)?;
        self.cursor = found.cursor;
        Ok(found)
    }

    /// Like `wait_peek`, but with settle fail-fast: after a scoped
    /// done/cleared status only `SETTLE_GRACE` remains for `what` to ride in
    /// (stop-hook reporters emit late events); a new running status re-opens
    /// the full window so follow-up turns keep working.
    fn wait_peek_until_settled(
        &self,
        what: &str,
        predicate: impl FnMut(&VerifyEvent) -> bool,
    ) -> Result<EventMatch, String> {
        let deadline = self.deadline;
        let mut cursor = self.cursor;
        let mut settle_deadline: Option<Instant> = None;
        let mut predicate = predicate;
        loop {
            let limit = settle_deadline.map_or(deadline, |settle| settle.min(deadline));
            let now = Instant::now();
            if now >= limit {
                return Err(settled_error(settle_deadline.is_some(), what));
            }
            let found = self.ledger.wait_for(cursor, limit - now, |event| {
                self.is_scoped(event)
                    && (predicate(event)
                        || matches!(
                            event,
                            VerifyEvent::Agent {
                                status: Some(_),
                                ..
                            }
                        ))
            });
            let Ok(found) = found else {
                return Err(settled_error(settle_deadline.is_some(), what));
            };
            if predicate(&found.event) {
                return Ok(found);
            }
            cursor = found.cursor;
            if let VerifyEvent::Agent {
                status: Some(status),
                ..
            } = &found.event
            {
                match status {
                    AgentStatus::Done | AgentStatus::Cleared => {
                        if settle_deadline.is_none() {
                            settle_deadline = Some(Instant::now() + self.settle_grace);
                        }
                    }
                    AgentStatus::Running => settle_deadline = None,
                    AgentStatus::Attention => {}
                }
            }
        }
    }

    fn is_scoped(&self, event: &VerifyEvent) -> bool {
        scoped(event, self.worktree_id(), self.tab_id(), self.agent_id)
    }

    pub fn remaining_timeout(&self) -> Result<Duration, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err("scenario timeout exhausted".to_string())
        } else {
            Ok(remaining)
        }
    }
}

impl Drop for ScenarioSession<'_> {
    fn drop(&mut self) {
        if self.active {
            let _ = self.api.kill_session(self.tab_id());
        }
    }
}

fn settled_error(settled: bool, what: &str) -> String {
    if settled {
        format!("agent settled without {what}")
    } else {
        "timed out waiting for agent event".to_string()
    }
}

fn scoped(event: &VerifyEvent, worktree_id: &str, tab_id: &str, agent_id: &str) -> bool {
    event
        .scope()
        .is_some_and(|(event_worktree, event_tab, event_agent)| {
            event_worktree == worktree_id && event_tab == tab_id && event_agent == agent_id
        })
}

#[cfg(test)]
mod tests {
    use std::thread;
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
            _spec: &crate::agent_verify::gateway::LaunchSpec<'_>,
        ) -> Result<LaunchResult, String> {
            Ok(LaunchResult {
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
            })
        }
        fn clear_status(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
        ) -> Result<(), String> {
            Ok(())
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

    fn session<'a>(
        api: &'a dyn crate::agent_verify::gateway::VerifyApi,
        ledger: &'a Ledger,
        agent_id: &'a str,
    ) -> ScenarioSession<'a> {
        ScenarioSession {
            api,
            ledger,
            agent_id,
            deadline: Instant::now() + Duration::from_millis(500),
            settle_grace: Duration::from_millis(100),
            launch: LaunchResult {
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
            },
            start_cursor: 0,
            cursor: 0,
            active: false,
            prompt: "prompt".to_string(),
            prefill_plain: false,
            prefill_submit: "\r".to_string(),
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

    /// A `pragma-watch`-style recorder for `write_input`, so the prefill retry
    /// path is observable.
    struct RecordingApi {
        writes: std::sync::Mutex<Vec<Vec<u8>>>,
        write_error: Option<String>,
    }

    impl crate::agent_verify::gateway::VerifyApi for RecordingApi {
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
            _spec: &crate::agent_verify::gateway::LaunchSpec<'_>,
        ) -> Result<LaunchResult, String> {
            Ok(LaunchResult {
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
            })
        }
        fn clear_status(
            &self,
            _agent: &str,
            _worktree_id: &str,
            _tab_id: &str,
        ) -> Result<(), String> {
            Ok(())
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
        fn write_input(&self, _session_id: &str, bytes: &[u8]) -> Result<(), String> {
            if let Some(error) = &self.write_error {
                return Err(error.clone());
            }
            if let Ok(mut writes) = self.writes.lock() {
                writes.push(bytes.to_vec());
            }
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

    /// A prefill swallowed by a slow TUI boot is retyped exactly once: enough
    /// to recover without risking duplicate turns from repeated prompt sends.
    #[test]
    fn await_running_retypes_prompt_after_first_window() {
        let ledger = Ledger::default();
        let api = RecordingApi {
            writes: std::sync::Mutex::new(Vec::new()),
            write_error: None,
        };
        let mut session = session(&api, &ledger, "a");
        let feeder = ledger.clone();
        thread::spawn(move || {
            // Land the running report inside the second half-window, well
            // after the first half (250ms of the 500ms test timeout) expired.
            thread::sleep(Duration::from_millis(300));
            feeder.ingest_line(&agent_status_line("running"));
        });
        session.await_running().expect("running after retry");
        let writes = api.writes.lock().expect("writes lock");
        assert_eq!(writes.len(), 2, "expected prompt body + submit writes");
        assert_eq!(writes[0], b"\x1b[200~prompt\x1b[201~".to_vec());
        assert_eq!(writes[1], b"\r".to_vec());
    }

    /// A prompt running report inside the first window must not trigger the
    /// prefill retry.
    #[test]
    fn await_running_skips_retype_when_prompt_lands() {
        let ledger = Ledger::default();
        ledger.ingest_line(&agent_status_line("running"));
        let api = RecordingApi {
            writes: std::sync::Mutex::new(Vec::new()),
            write_error: None,
        };
        let mut session = session(&api, &ledger, "a");
        session.await_running().expect("running");
        assert!(api.writes.lock().expect("writes lock").is_empty());
    }

    #[test]
    fn headless_launch_surfaces_terminal_server_error_immediately() {
        let api = RecordingApi {
            writes: std::sync::Mutex::new(Vec::new()),
            write_error: Some("server error: session not found: t".to_string()),
        };
        let ledger = Ledger::default();
        let context = ScenarioCtx {
            api: &api,
            ledger: &ledger,
            project_id: "p",
            worktree_id: "w",
            catalog_agent_id: "plugin.a",
            plugin_id: "plugin",
            runtime_agent_id: "a",
            model_id: None,
            model_cmd: None,
            attempt_timeout: Duration::from_secs(30),
            abort_input: b"\x1b",
            headless: true,
            prefill_plain: false,
            prefill_submit: "\r",
            launched_tabs: Mutex::new(Vec::new()),
            all_launched_tabs: &Mutex::new(Vec::new()),
        };

        let started = Instant::now();
        let Err(error) = context.launch("prompt") else {
            panic!("launch should fail");
        };

        assert_eq!(
            error,
            "terminal failed to launch: server error: session not found: t"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn fresh_launch_gets_fresh_timeout_budget() {
        let api = RecordingApi {
            writes: std::sync::Mutex::new(Vec::new()),
            write_error: None,
        };
        let ledger = Ledger::default();
        let context = ScenarioCtx {
            api: &api,
            ledger: &ledger,
            project_id: "p",
            worktree_id: "w",
            catalog_agent_id: "plugin.a",
            plugin_id: "plugin",
            runtime_agent_id: "a",
            model_id: None,
            model_cmd: None,
            attempt_timeout: Duration::from_secs(1),
            abort_input: b"\x1b",
            headless: true,
            prefill_plain: false,
            prefill_submit: "\r",
            launched_tabs: Mutex::new(Vec::new()),
            all_launched_tabs: &Mutex::new(Vec::new()),
        };
        thread::sleep(Duration::from_millis(20));

        let session = context.launch("prompt").expect("launch");

        assert!(session.remaining_timeout().expect("remaining") > Duration::from_millis(900));
    }

    /// A session that settles without ever raising the awaited attention must
    /// fail `settle_grace` after done, not burn the whole step timeout.
    #[test]
    fn await_attention_fails_fast_after_settle() {
        let ledger = Ledger::default();
        ledger.ingest_line(&agent_status_line("running"));
        ledger.ingest_line(&agent_status_line("done"));
        let api = StubApi;
        let mut session = session(&api, &ledger, "a");
        session.deadline = Instant::now() + Duration::from_secs(30);
        let started = std::time::Instant::now();
        let error = session
            .await_attention(pragma_constants::AgentAttentionKind::Command)
            .expect_err("attention after settle");
        assert_eq!(error, "agent settled without command attention");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "settle fail-fast took {:?}",
            started.elapsed()
        );
    }

    /// A settle without any assistant message must fail with the settled
    /// error, not the generic timeout.
    #[test]
    fn await_assistant_message_fails_fast_after_settle() {
        let ledger = Ledger::default();
        ledger.ingest_line(&agent_status_line("running"));
        ledger.ingest_line(&agent_status_line("cleared"));
        let api = StubApi;
        let mut session = session(&api, &ledger, "a");
        session.deadline = Instant::now() + Duration::from_secs(30);
        let error = session
            .await_assistant_message()
            .expect_err("message after settle");
        assert_eq!(error, "agent settled without an assistant message");
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
