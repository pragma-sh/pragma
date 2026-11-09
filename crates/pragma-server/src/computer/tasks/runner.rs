//! Observe → decide → validate → act → verify. Every mutation uses the direct-call pipeline.
use super::{
    extract_variables, failure, invalid, json, now_ms, Arc, BTreeMap, ComputerDecideRequest,
    ComputerDecision, ComputerDecisionKind, ComputerErrorCode, ComputerFailure, ComputerHost,
    ComputerService, ComputerTask, ComputerTaskStatus, ComputerTaskStep, Path, Value, CONSTANTS,
};
use pragma_constants::{ComputerApp, ComputerSnapshot};
use pragma_core::computer_task::{screen_hash, validate_decision};
use std::time::{Duration, Instant};

struct Run<'a> {
    service: &'a Arc<ComputerService>,
    host: &'a dyn ComputerHost,
    id: &'a str,
    generation: u64,
    started: Instant,
    decider: Option<super::super::decide::Decider>,
    tried: BTreeMap<String, u8>,
    no_progress: u8,
    apps: Vec<ComputerApp>,
}
impl ComputerService {
    pub(super) fn drive_task(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        id: &str,
        generation: u64,
    ) -> Result<(), ComputerFailure> {
        let task = self.tasks.get(id)?;
        let apps =
            super::super::from_value(self.task_call(host, &task.owner, json!({"op":"apps"}))?)?;
        let mut run = Run {
            service: self,
            host,
            id,
            generation,
            started: Instant::now(),
            decider: None,
            tried: BTreeMap::new(),
            no_progress: 0,
            apps,
        };
        if !run.open_target(&task)? {
            return Ok(());
        }
        while run.step()? {}
        Ok(())
    }
}
impl Run<'_> {
    fn open_target(&self, task: &ComputerTask) -> Result<bool, ComputerFailure> {
        let app = task.app.clone().or_else(|| {
            let named: Vec<_> = self
                .apps
                .iter()
                .filter(|a| {
                    a.blocked != Some(true)
                        && task
                            .instruction
                            .to_lowercase()
                            .contains(&a.name.to_lowercase())
                })
                .collect();
            (named.len() == 1).then(|| named[0].id.clone())
        });
        let Some(app) = app else {
            self.service.need_task_input(
                self.id,
                self.generation,
                "app",
                self.apps
                    .iter()
                    .filter(|a| a.blocked != Some(true))
                    .map(|a| a.id.clone()),
            )?;
            return Ok(false);
        };
        self.service
            .tasks
            .update(self.id, self.generation, |e| e.task.app = Some(app.clone()))?;
        let result = self.call(task, json!({"op":"open","app":app,"activate":false}))?;
        self.service.tasks.update(self.id, self.generation, |e| {
            e.task.session_id = result["sessionId"].as_str().map(str::to_string);
            if let Some(id) = result["app"]["id"].as_str() {
                e.task.app = Some(id.to_string());
            }
        })?;
        Ok(true)
    }
    fn current(&self) -> Result<(ComputerTask, BTreeMap<String, String>), ComputerFailure> {
        let entries = self
            .service
            .tasks
            .inner
            .lock()
            .map_err(|_| invalid("Task store unavailable"))?;
        let entry = entries
            .get(self.id)
            .ok_or_else(|| invalid("Unknown task"))?;
        if entry.generation != self.generation || entry.task.status == ComputerTaskStatus::Cancelled
        {
            return Err(failure(ComputerErrorCode::Stopped, "Task cancelled"));
        }
        Ok((entry.task.clone(), entry.values.clone()))
    }
    fn checkpoint(&self) -> Result<(), ComputerFailure> {
        self.current()?;
        self.service.preflight(self.host)?;
        Ok(())
    }
    fn finish(&self, status: ComputerTaskStatus, code: &str) -> Result<bool, ComputerFailure> {
        self.service
            .task_change(self.id, self.generation, status, code)?;
        Ok(false)
    }
    fn step(&mut self) -> Result<bool, ComputerFailure> {
        self.checkpoint()?;
        let (task, values) = self.current()?;
        if task.steps.len() as u64
            >= task
                .budgets
                .max_steps
                .unwrap_or(CONSTANTS.computer.task_max_steps)
                .get()
        {
            return self.finish(ComputerTaskStatus::Failed, "limitSteps");
        }
        if self.started.elapsed().as_millis()
            >= u128::from(
                task.budgets
                    .max_time_ms
                    .unwrap_or(CONSTANTS.computer.task_max_time_ms)
                    .get(),
            )
        {
            return self.finish(ComputerTaskStatus::Failed, "limitTime");
        }
        if !task
            .variable_names
            .iter()
            .all(|name| values.contains_key(name))
        {
            self.service.need_task_input(
                self.id,
                self.generation,
                "task variables lost on restart (supply the original names)",
                vec![],
            )?;
            return Ok(false);
        }
        let snapshot: ComputerSnapshot =
            super::super::from_value(self.call(&task, json!({"op":"inspect","app":task.app}))?)?;
        let hash = screen_hash(&snapshot);
        if let Some(result) = self.recipe(&task, &values, &snapshot)? {
            return Ok(result);
        }
        let request = ComputerDecideRequest {
            instruction: task.instruction.clone(),
            snapshot: snapshot.clone(),
            apps: self.apps.clone(),
            variables: values
                .keys()
                .filter(|n| *n != "target" && *n != "app")
                .cloned()
                .collect(),
            history: task.steps.clone(),
            tried: self
                .tried
                .iter()
                .filter(|(key, count)| key.starts_with(&hash) && **count >= 2)
                .map(|(key, _)| key.clone())
                .collect(),
        };
        let decision = self.decision(&task, &request, &values);
        let decision = match decision {
            Ok(d) => d,
            Err(code) => return self.finish(ComputerTaskStatus::Failed, code),
        };
        self.apply_decision(&task, &request, &decision, &values, hash)
    }
    fn apply_decision(
        &mut self,
        task: &ComputerTask,
        request: &ComputerDecideRequest,
        decision: &ComputerDecision,
        values: &BTreeMap<String, String>,
        hash: String,
    ) -> Result<bool, ComputerFailure> {
        let snapshot = &request.snapshot;
        self.service.tasks.update(self.id, self.generation, |e| {
            e.task.last_snapshot_id = Some(snapshot.id.clone());
        })?;
        if let Err(code) = validate_decision(request, decision) {
            if code == "missingInput" {
                self.service
                    .need_task_input(self.id, self.generation, "text", vec![])?;
                return Ok(false);
            }
            if code == "ambiguousTarget" {
                self.service.need_task_input(
                    self.id,
                    self.generation,
                    "target",
                    snapshot
                        .elements
                        .iter()
                        .filter(|e| e.enabled && !e.secure)
                        .take(20)
                        .map(|e| e.key.clone()),
                )?;
                return Ok(false);
            }
            return self.finish(ComputerTaskStatus::Failed, code);
        }
        match decision.kind {
            ComputerDecisionKind::Done => {
                return self.finish(ComputerTaskStatus::Completed, "completed")
            }
            ComputerDecisionKind::Stuck => return self.finish(ComputerTaskStatus::Failed, "stuck"),
            ComputerDecisionKind::RequestText => {
                self.service
                    .need_task_input(self.id, self.generation, "text", vec![])?;
                return Ok(false);
            }
            _ => {}
        }
        let key = action_key(&hash, snapshot, decision);
        if self.tried.get(&key).is_some_and(|count| *count >= 2) {
            return self.finish(ComputerTaskStatus::Failed, "stuck");
        }
        self.checkpoint()?;
        self.execute(task, decision, values)?;
        let changed = self.verify(task, &hash)?;
        if changed {
            self.no_progress = 0;
        } else {
            *self.tried.entry(key).or_default() += 1;
            self.no_progress += 1;
        }
        let recorded = self.service.tasks.update(self.id, self.generation, |e| {
            e.values.remove("target");
            e.task.steps.push(ComputerTaskStep {
                index: e.task.steps.len() as u64 + 1,
                at: now_ms(),
                snapshot_id: Some(snapshot.id.clone()),
                screen_hash: Some(hash),
                action: format!("{:?}", decision.kind),
                changed,
            });
        })?;
        self.service.task_event(&recorded);
        // A single explicit click is complete once the native action succeeded; broader goals need visual evidence.
        if task.instruction.trim().starts_with("click \"")
            && task.instruction.trim().ends_with('"')
            && task.instruction.matches('"').count() == 2
            && decision.kind == ComputerDecisionKind::ClickItem
        {
            return self.finish(ComputerTaskStatus::Completed, "completed");
        }
        if self.no_progress >= 3 {
            return self.finish(ComputerTaskStatus::Failed, "stuck");
        }
        Ok(true)
    }
    fn recipe(
        &self,
        task: &ComputerTask,
        values: &BTreeMap<String, String>,
        snapshot: &ComputerSnapshot,
    ) -> Result<Option<bool>, ComputerFailure> {
        use pragma_core::computer_task::url_host;
        let goal = task.instruction.to_lowercase();
        let navigation = goal.contains("navigate")
            || goal.contains("go to")
            || (goal.starts_with("open ") && values.contains_key("url"));
        let browser = matches!(
            snapshot.app.name.to_lowercase().as_str(),
            "safari" | "google chrome" | "microsoft edge" | "firefox" | "brave browser" | "arc"
        );
        if navigation && browser {
            if let Some(url) = values.get("url").filter(|url| url_host(url).is_some()) {
                if snapshot
                    .url
                    .as_ref()
                    .is_some_and(|seen| url_host(seen) == url_host(url))
                {
                    return self
                        .finish(ComputerTaskStatus::Completed, "completed")
                        .map(Some);
                }
                if !task.steps.iter().any(|s| s.action == "navigateUrl") {
                    self.call(
                        task,
                        json!({"op":"open","app":task.app,"url":url,"activate":false}),
                    )?;
                    self.record_recipe(snapshot, "navigateUrl", false)?;
                    return Ok(Some(true));
                }
            } else {
                self.service
                    .need_task_input(self.id, self.generation, "url", vec![])?;
                return Ok(Some(false));
            }
        }
        let literal_fill = (goal.starts_with("type \"") || goal.starts_with("enter \""))
            && task.instruction.trim().ends_with('"')
            && task.instruction.matches('"').count() == 2;
        let focused_fill = goal.trim() == "fill focused";
        if focused_fill && !values.contains_key("text") {
            self.service
                .need_task_input(self.id, self.generation, "text", vec![])?;
            return Ok(Some(false));
        }
        if literal_fill || focused_fill {
            let text = if literal_fill {
                values.get("quoted_1")
            } else {
                values.get("text")
            };
            if let (Some(text), Some(field)) = (
                text,
                snapshot
                    .elements
                    .iter()
                    .find(|e| e.focused && e.editable && !e.secure),
            ) {
                if field.value.as_deref() == Some(text) {
                    return self
                        .finish(ComputerTaskStatus::Completed, "completed")
                        .map(Some);
                }
                if !task.steps.iter().any(|s| s.action == "fillFocused") {
                    self.call(task,json!({"op":"type","element":field.id,"text":text,"replace":true,"secret":task.secret_names.contains(&"text".to_string())}))?;
                    self.record_recipe(snapshot, "fillFocused", false)?;
                    return Ok(Some(true));
                }
            }
        }
        if goal.trim() == "dismiss popover"
            && !task.steps.iter().any(|s| s.action == "dismissPopover")
        {
            self.call(task, json!({"op":"key","app":task.app,"chords":["escape"]}))?;
            let changed = self.verify(task, &screen_hash(snapshot))?;
            self.record_recipe(snapshot, "dismissPopover", changed)?;
            if changed {
                return self
                    .finish(ComputerTaskStatus::Completed, "completed")
                    .map(Some);
            }
        }
        Ok(None)
    }
    fn record_recipe(
        &self,
        snapshot: &ComputerSnapshot,
        action: &str,
        changed: bool,
    ) -> Result<(), ComputerFailure> {
        let task = self.service.tasks.update(self.id, self.generation, |e| {
            e.task.steps.push(ComputerTaskStep {
                index: e.task.steps.len() as u64 + 1,
                at: now_ms(),
                snapshot_id: Some(snapshot.id.clone()),
                screen_hash: Some(screen_hash(snapshot)),
                action: action.to_string(),
                changed,
            });
        })?;
        self.service.task_event(&task);
        Ok(())
    }
    fn decision(
        &mut self,
        task: &ComputerTask,
        request: &ComputerDecideRequest,
        values: &BTreeMap<String, String>,
    ) -> Result<ComputerDecision, &'static str> {
        if let Some(target) = values.get("target").and_then(|key| {
            request
                .snapshot
                .elements
                .iter()
                .find(|e| e.id == *key || e.key == *key)
        }) {
            return Ok(click_decision(&target.id));
        }
        if let Some(decision) = deterministic(task, request) {
            return Ok(decision);
        }
        if task.model_calls
            >= task
                .budgets
                .max_model_calls
                .unwrap_or(CONSTANTS.computer.task_max_model_calls)
                .get()
        {
            return Err("limitModelCalls");
        }
        if self.decider.is_none() {
            self.decider = Some(
                super::super::decide::Decider::start(
                    self.service.tasks.path.parent().unwrap_or(Path::new(".")),
                    self.service.home.as_deref(),
                )
                .map_err(|_| "modelUnavailable")?,
            );
        }
        self.service
            .tasks
            .update(self.id, self.generation, |e| e.task.model_calls += 1)
            .map_err(|_| "cancelled")?;
        let service = self.service;
        let id = self.id;
        let generation = self.generation;
        let remaining = Duration::from_millis(
            task.budgets
                .max_time_ms
                .unwrap_or(CONSTANTS.computer.task_max_time_ms)
                .get(),
        )
        .saturating_sub(self.started.elapsed());
        self.decider
            .as_mut()
            .ok_or("modelUnavailable")?
            .decide(request, remaining, || {
                service.tasks.inner.lock().map_or(true, |entries| {
                    entries.get(id).is_none_or(|e| {
                        e.generation != generation || e.task.status == ComputerTaskStatus::Cancelled
                    })
                })
            })
            .map_err(|_| "modelError")
    }
    fn execute(
        &self,
        task: &ComputerTask,
        decision: &ComputerDecision,
        values: &BTreeMap<String, String>,
    ) -> Result<(), ComputerFailure> {
        let action = match decision.kind {
            ComputerDecisionKind::ClickItem => json!({"op":"click","element":decision.item}),
            ComputerDecisionKind::TypeVariable => {
                let name = decision
                    .variable
                    .as_ref()
                    .ok_or_else(|| invalid("Missing variable"))?;
                json!({"op":"type","element":decision.item,"text":values.get(name).ok_or_else(||invalid("Missing input"))?,"secret":task.secret_names.contains(name),"replace":true})
            }
            ComputerDecisionKind::PressKey => {
                json!({"op":"key","app":task.app,"chords":[decision.key]})
            }
            ComputerDecisionKind::ScrollDown | ComputerDecisionKind::ScrollUp => {
                json!({"op":"scroll","app":task.app,"direction":if decision.kind==ComputerDecisionKind::ScrollDown{"down"}else{"up"},"amount":3})
            }
            ComputerDecisionKind::SwitchApp => {
                self.service.tasks.update(self.id, self.generation, |e| {
                    e.task.app.clone_from(&decision.app);
                })?;
                json!({"op":"open","app":decision.app,"activate":false})
            }
            ComputerDecisionKind::WaitForChange => return Ok(()),
            _ => return Err(invalid("Invalid task action")),
        };
        self.call(task, action)?;
        Ok(())
    }
    fn verify(&self, task: &ComputerTask, hash: &str) -> Result<bool, ComputerFailure> {
        let settle = Instant::now();
        let app = self.service.tasks.get(self.id)?.app;
        while settle.elapsed() < Duration::from_millis(1500) {
            std::thread::sleep(Duration::from_millis(100));
            self.checkpoint()?;
            let fresh: ComputerSnapshot =
                super::super::from_value(self.call(task, json!({"op":"inspect","app":app}))?)?;
            if screen_hash(&fresh) != hash {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn call(&self, task: &ComputerTask, mut payload: Value) -> Result<Value, ComputerFailure> {
        self.checkpoint()?;
        payload["task"] = json!({"id":self.id,"generation":self.generation});
        self.service.task_call(self.host, &task.owner, payload)
    }
}
fn action_key(hash: &str, snapshot: &ComputerSnapshot, d: &ComputerDecision) -> String {
    format!(
        "{hash}:{:?}:{}:{}",
        d.kind,
        d.item
            .as_ref()
            .and_then(|id| snapshot.elements.iter().find(|e| &e.id == id))
            .map_or("", |e| e.key.as_str()),
        d.variable.as_deref().or(d.key.as_deref()).unwrap_or("")
    )
}
fn click_decision(id: &str) -> ComputerDecision {
    ComputerDecision {
        kind: ComputerDecisionKind::ClickItem,
        item: Some(id.to_string()),
        variable: None,
        key: None,
        app: None,
        confidence: 1.0,
        item_confidence: Some(1.0),
        item_margin: Some(1.0),
        achieved: 0.0,
    }
}

fn deterministic(task: &ComputerTask, request: &ComputerDecideRequest) -> Option<ComputerDecision> {
    // Exact quoted control labels are deterministic only when unique and enabled.
    let quoted = extract_variables(&task.instruction);
    let hits: Vec<_> = request
        .snapshot
        .elements
        .iter()
        .filter(|e| {
            e.enabled
                && !e.secure
                && quoted
                    .values()
                    .any(|value| value.eq_ignore_ascii_case(&e.label))
        })
        .collect();
    if task.instruction.to_lowercase().starts_with("click ") && hits.len() == 1 {
        return Some(ComputerDecision {
            kind: ComputerDecisionKind::ClickItem,
            item: Some(hits[0].id.clone()),
            variable: None,
            key: None,
            app: None,
            confidence: 1.0,
            item_confidence: Some(1.0),
            item_margin: Some(1.0),
            achieved: 0.0,
        });
    }
    None
}
