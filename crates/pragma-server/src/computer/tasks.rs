//! Durable host-owned computer tasks. Input values are memory-only; disk and activity contain metadata.
use super::{now_ms, ComputerHost, ComputerOpRequest, ComputerService};
use pragma_constants::{
    ComputerCaller, ComputerCallerKind, ComputerDecideRequest, ComputerDecision,
    ComputerDecisionKind, ComputerErrorCode, ComputerFailure, ComputerResumeRequest,
    ComputerRunRequest, ComputerTask, ComputerTaskBudgets, ComputerTaskStatus, ComputerTaskStep,
    CONSTANTS,
};
use pragma_core::computer::{failure, owner_key};
use pragma_core::computer_task::extract_variables;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
mod runner;

/// Correlates an action with the exact task generation that planned it.
#[derive(Clone, Debug, serde::Deserialize)]
pub(super) struct TaskGuard {
    pub id: String,
    pub generation: u64,
}

struct Entry {
    task: ComputerTask,
    values: BTreeMap<String, String>,
    generation: u64,
    active: bool,
}
/// Metadata plus volatile values, guarded together so cancel/resume cannot race a worker.
pub struct Tasks {
    path: PathBuf,
    inner: Mutex<HashMap<String, Entry>>,
}

fn terminal(status: ComputerTaskStatus) -> bool {
    matches!(
        status,
        ComputerTaskStatus::Completed | ComputerTaskStatus::Failed | ComputerTaskStatus::Cancelled
    )
}
fn invalid(message: &str) -> ComputerFailure {
    failure(ComputerErrorCode::InvalidPayload, message)
}
fn defaults(budgets: Option<ComputerTaskBudgets>) -> ComputerTaskBudgets {
    let mut b = budgets.unwrap_or_default();
    b.max_steps = Some(
        b.max_steps
            .unwrap_or(CONSTANTS.computer.task_max_steps)
            .min(CONSTANTS.computer.task_history_limit),
    );
    b.max_time_ms = Some(b.max_time_ms.unwrap_or(CONSTANTS.computer.task_max_time_ms));
    b.max_model_calls = Some(
        b.max_model_calls
            .unwrap_or(CONSTANTS.computer.task_max_model_calls),
    );
    b
}
impl Tasks {
    pub(super) fn check_guard(
        &self,
        caller: &ComputerCaller,
        guard: Option<&TaskGuard>,
    ) -> Result<(), ComputerFailure> {
        let Some(guard) = guard else {
            return Ok(());
        };
        let entries = self
            .inner
            .lock()
            .map_err(|_| invalid("Task store unavailable"))?;
        let entry = entries
            .get(&guard.id)
            .ok_or_else(|| invalid("Unknown task"))?;
        owns(caller, &entry.task)?;
        if entry.generation != guard.generation || !entry.active || terminal(entry.task.status) {
            return Err(failure(
                ComputerErrorCode::Stopped,
                "Task was paused, stopped, or replaced. Please ask the user to resume or restart.",
            ));
        }
        Ok(())
    }
    pub fn load(server_dir: &Path) -> Self {
        let path = server_dir.join(&CONSTANTS.computer.tasks_file);
        let tasks: Vec<ComputerTask> = std::fs::read(&path)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        let inner = tasks
            .into_iter()
            .filter_map(|mut task| {
                if terminal(task.status)
                    && now_ms().saturating_sub(task.updated_at)
                        > CONSTANTS.computer.task_retention_ms.get()
                {
                    return None;
                }
                if !terminal(task.status) {
                    task.status = ComputerTaskStatus::Failed;
                    task.code = Some("interrupted".to_string());
                    task.resumable = true;
                    task.summary = Some(
                        "The host restarted. Supply task variables again before resuming."
                            .to_string(),
                    );
                }
                Some((
                    task.id.clone(),
                    Entry {
                        task,
                        values: BTreeMap::new(),
                        generation: 0,
                        active: false,
                    },
                ))
            })
            .collect();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }
    pub fn all(&self) -> Vec<ComputerTask> {
        self.inner
            .lock()
            .map(|entries| entries.values().map(|e| e.task.clone()).collect())
            .unwrap_or_default()
    }
    fn persist(&self, entries: &HashMap<String, Entry>) -> Result<(), ComputerFailure> {
        let result = (|| -> std::io::Result<()> {
            let bytes = serde_json::to_vec(&entries.values().map(|e| &e.task).collect::<Vec<_>>())?;
            let temporary = self.path.with_extension("tmp");
            let mut file = pragma_platform::perms::create_private_file(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(temporary, &self.path)
        })();
        result.map_err(|_| {
            failure(
                ComputerErrorCode::Internal,
                "Could not persist computer task",
            )
        })
    }
    fn get(&self, id: &str) -> Result<ComputerTask, ComputerFailure> {
        self.inner
            .lock()
            .ok()
            .and_then(|entries| entries.get(id).map(|e| e.task.clone()))
            .ok_or_else(|| invalid("Unknown computer task"))
    }
    fn update(
        &self,
        id: &str,
        generation: u64,
        update: impl FnOnce(&mut Entry),
    ) -> Result<ComputerTask, ComputerFailure> {
        let mut entries = self
            .inner
            .lock()
            .map_err(|_| invalid("Task store unavailable"))?;
        let entry = entries
            .get_mut(id)
            .ok_or_else(|| invalid("Unknown computer task"))?;
        if entry.generation != generation || entry.task.status == ComputerTaskStatus::Cancelled {
            return Err(failure(ComputerErrorCode::Stopped, "Task was cancelled"));
        }
        update(entry);
        entry.task.updated_at = now_ms();
        let task = entry.task.clone();
        self.persist(&entries)?;
        Ok(task)
    }
    /// Invalidates a worker immediately while preserving its resumable inputs.
    pub(super) fn pause(&self, owner: Option<&ComputerCaller>) -> Vec<ComputerTask> {
        let Ok(mut entries) = self.inner.lock() else {
            return vec![];
        };
        let mut changed = vec![];
        for entry in entries.values_mut().filter(|e| {
            !terminal(e.task.status)
                && e.task.status != ComputerTaskStatus::Paused
                && owner.is_none_or(|caller| owner_key(&e.task.owner) == owner_key(caller))
        }) {
            entry.generation += 1;
            entry.task.status = ComputerTaskStatus::Paused;
            entry.task.code = Some("userPaused".to_string());
            entry.task.summary = Some(
                "User paused the task. Please ask the user to resume before continuing."
                    .to_string(),
            );
            entry.task.resumable = true;
            entry.task.updated_at = now_ms();
            changed.push(entry.task.clone());
        }
        let _ = self.persist(&entries);
        changed
    }

    pub fn cancel_session(&self, session: &str) {
        self.cancel_matching(|e| e.task.session_id.as_deref() == Some(session));
    }
    pub fn cancel_all(&self) {
        self.cancel_matching(|_| true);
    }
    pub fn cancel_owner(&self, caller: &ComputerCaller) {
        self.cancel_matching(|e| owner_key(&e.task.owner) == owner_key(caller));
    }
    pub fn cancel_tab(&self, tab: &str) {
        self.cancel_matching(|e| e.task.owner.tab_id.as_deref() == Some(tab));
    }
    pub(super) fn approval_state(
        &self,
        caller: &ComputerCaller,
        waiting: bool,
    ) -> Vec<ComputerTask> {
        let Ok(mut entries) = self.inner.lock() else {
            return vec![];
        };
        let mut changed = vec![];
        for entry in entries.values_mut().filter(|e| {
            e.active
                && matches!(
                    e.task.status,
                    ComputerTaskStatus::Running | ComputerTaskStatus::NeedsApproval
                )
                && owner_key(&e.task.owner) == owner_key(caller)
        }) {
            entry.task.status = if waiting {
                ComputerTaskStatus::NeedsApproval
            } else {
                ComputerTaskStatus::Running
            };
            changed.push(entry.task.clone());
        }
        let _ = self.persist(&entries);
        changed
    }
    fn cancel_matching(&self, matches: impl Fn(&Entry) -> bool) {
        if let Ok(mut entries) = self.inner.lock() {
            for entry in entries
                .values_mut()
                .filter(|e| !terminal(e.task.status) && matches(e))
            {
                entry.task.status = ComputerTaskStatus::Cancelled;
                entry.task.resumable = false;
                entry.task.code = Some("cancelled".to_string());
                entry.task.summary =
                    Some("Task stopped. Please ask the user before restarting.".to_string());
                entry.task.updated_at = now_ms();
                entry.generation += 1;
                entry.values.clear();
            }
            let _ = self.persist(&entries);
        }
    }
}

impl ComputerService {
    pub(super) fn task_rpc(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerOpRequest,
    ) -> Result<Value, ComputerFailure> {
        match request {
            ComputerOpRequest::Task(request) => super::to_value(&self.tasks.get(&request.task_id)?),
            ComputerOpRequest::Run(request) => self.start_task(host, caller, request),
            ComputerOpRequest::Resume(request) => self.resume_task(host, caller, request),
            ComputerOpRequest::Cancel(request) => {
                let task = self.tasks.get(&request.task_id)?;
                owns(caller, &task)?;
                self.tasks.cancel_matching(|e| e.task.id == request.task_id);
                self.policy.deny_caller(&task.owner);
                let task = self.tasks.get(&request.task_id)?;
                self.task_event(&task);
                super::to_value(&task)
            }
            other => Err(super::misrouted(&other)),
        }
    }
    fn start_task(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerRunRequest,
    ) -> Result<Value, ComputerFailure> {
        self.preflight(host)?;
        self.check_caller_session(caller)?;
        validate_values(&request.instruction, &request.inputs, &request.secrets)?;
        if request.request_id.trim().is_empty() || request.instruction.trim().is_empty() {
            return Err(invalid("requestId and instruction are required"));
        }
        let mut entries = self
            .tasks
            .inner
            .lock()
            .map_err(|_| invalid("Task store unavailable"))?;
        if let Some(entry) = entries.values().find(|e| {
            owner_key(&e.task.owner) == owner_key(caller) && e.task.request_id == request.request_id
        }) {
            return super::to_value(&entry.task);
        }
        entries.retain(|_, e| {
            !terminal(e.task.status)
                || e.active
                || now_ms().saturating_sub(e.task.updated_at)
                    < CONSTANTS.computer.task_retention_ms.get()
        });
        while entries.len()
            >= usize::try_from(CONSTANTS.computer.task_record_limit.get()).unwrap_or(64)
        {
            let oldest = entries
                .iter()
                .filter(|(_, e)| terminal(e.task.status) && !e.active)
                .min_by_key(|(_, e)| e.task.updated_at)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            } else {
                return Err(invalid("Finish or cancel an existing computer task first"));
            }
        }
        let active = entries.values().filter(|e| e.active).count();
        if active >= usize::try_from(CONSTANTS.computer.task_max_active.get()).unwrap_or(8) {
            return Err(invalid("Too many active computer tasks"));
        }
        if entries.values().any(|e| {
            (!terminal(e.task.status) || e.active) && owner_key(&e.task.owner) == owner_key(caller)
        }) {
            return Err(invalid(
                "Finish or cancel this caller's existing task first",
            ));
        }
        let mut values = extract_variables(&request.instruction);
        values.extend(request.inputs);
        let secret_names: Vec<String> = request.secrets.keys().cloned().collect();
        values.extend(request.secrets);
        if values.len() > 64 {
            return Err(invalid("Computer task input exceeds its limits"));
        }
        let mut instruction = request.instruction;
        for name in &secret_names {
            if let Some(value) = values.get(name).filter(|s| !s.is_empty()) {
                instruction = instruction.replace(value, "[secret]");
            }
        }
        let id = format!("ct_{}", uuid::Uuid::new_v4().simple());
        let now = now_ms();
        // Give even an app-selection/model-wait task a desktop-owned pause latch.
        let session = self.open_session(caller)?;
        let task = ComputerTask {
            id: id.clone(),
            request_id: request.request_id,
            owner: caller.clone(),
            instruction,
            app: request.app,
            status: ComputerTaskStatus::Running,
            session_id: Some(session.id),
            created_at: now,
            updated_at: now,
            steps: vec![],
            model_calls: 0,
            budgets: defaults(request.budgets),
            resumable: false,
            code: None,
            summary: None,
            question: None,
            requested_inputs: vec![],
            variable_names: values.keys().cloned().collect(),
            secret_names,
            last_snapshot_id: None,
        };
        entries.insert(
            id.clone(),
            Entry {
                task: task.clone(),
                values,
                generation: 0,
                active: true,
            },
        );
        self.tasks.persist(&entries)?;
        self.task_event(&task);
        drop(entries);
        self.spawn_task(&id, 0)?;
        super::to_value(&task)
    }
    fn resume_task(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerResumeRequest,
    ) -> Result<Value, ComputerFailure> {
        self.preflight(host)?;
        self.check_caller_session(caller)?;
        validate_values(
            request.note.as_deref().unwrap_or(""),
            &request.inputs,
            &request.secrets,
        )?;
        let mut entries = self
            .tasks
            .inner
            .lock()
            .map_err(|_| invalid("Task store unavailable"))?;
        let entry = entries
            .get_mut(&request.task_id)
            .ok_or_else(|| invalid("Unknown computer task"))?;
        owns(caller, &entry.task)?;
        if entry.active
            || entry.task.status == ComputerTaskStatus::Cancelled
            || entry.task.status == ComputerTaskStatus::Completed
            || (entry.task.status == ComputerTaskStatus::Failed && !entry.task.resumable)
        {
            return Err(invalid("This task cannot resume"));
        }
        let mut values = entry.values.clone();
        values.extend(request.inputs.clone());
        values.extend(request.secrets.clone());
        let note_length = request.note.as_ref().map_or(0, |note| note.len() + 14);
        if values.len() > 64
            || entry.task.instruction.len() + note_length
                > usize::try_from(CONSTANTS.computer.task_max_input_chars.get()).unwrap_or(16384)
        {
            return Err(invalid("Computer task input exceeds its limits"));
        }
        if let Some(app) = request.inputs.get("app") {
            entry.task.app = Some(app.clone());
        }
        entry.values = values;
        entry
            .task
            .secret_names
            .extend(request.secrets.keys().cloned());
        entry.task.secret_names.sort();
        entry.task.secret_names.dedup();
        entry.task.variable_names = entry.values.keys().cloned().collect();
        if let Some(note) = request.note {
            entry.task.instruction.push_str("\nCaller note: ");
            entry.task.instruction.push_str(&note);
        }
        for name in &entry.task.secret_names {
            if let Some(value) = entry.values.get(name).filter(|s| !s.is_empty()) {
                entry.task.instruction = entry.task.instruction.replace(value, "[secret]");
            }
        }
        if let Some(budgets) = request.budgets {
            entry.task.budgets = defaults(Some(budgets));
        }
        entry.task.updated_at = now_ms();
        entry.task.status = ComputerTaskStatus::Running;
        entry.task.code = None;
        entry.task.summary = None;
        entry.task.question = None;
        entry.task.requested_inputs.clear();
        entry.generation += 1;
        entry.active = true;
        let generation = entry.generation;
        let task = entry.task.clone();
        self.tasks.persist(&entries)?;
        self.task_event(&task);
        drop(entries);
        self.spawn_task(&task.id, generation)?;
        super::to_value(&task)
    }
    fn spawn_task(self: &Arc<Self>, id: &str, generation: u64) -> Result<(), ComputerFailure> {
        let host = self
            .task_host
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().and_then(std::sync::Weak::upgrade))
            .ok_or_else(|| invalid("Task host unavailable"))?;
        let service = Arc::clone(self);
        let id = id.to_string();
        std::thread::spawn(move || {
            let outcome = service.drive_task(host.as_ref(), &id, generation);
            if let Err(error) = outcome {
                let _ = service.tasks.update(&id, generation, |entry| {
                    entry.task.status = ComputerTaskStatus::Failed;
                    entry.task.code = Some(format!("{:?}", error.code));
                    // Native errors can contain typed text. Publish only a fixed description.
                    entry.task.summary = Some(
                        "Computer task stopped; inspect the target before resuming.".to_string(),
                    );
                    entry.task.resumable = error.retryable;
                });
            }
            if let Ok(mut entries) = service.tasks.inner.lock() {
                if let Some(entry) = entries.get_mut(&id) {
                    entry.active = false;
                    if terminal(entry.task.status) {
                        entry.values.clear();
                    }
                    let task = entry.task.clone();
                    let _ = service.tasks.persist(&entries);
                    drop(entries);
                    service.task_event(&task);
                }
            }
        });
        Ok(())
    }
    pub(super) fn task_event(&self, task: &ComputerTask) {
        let mut event = super::activity::event(pragma_constants::ComputerActivityType::TaskChanged);
        event.caller = Some(task.owner.clone());
        event.session_id.clone_from(&task.session_id);
        event.task = Some(task.clone());
        self.activity.emit(event);
    }
    fn task_change(
        &self,
        id: &str,
        generation: u64,
        status: ComputerTaskStatus,
        code: &str,
    ) -> Result<(), ComputerFailure> {
        let task = self.tasks.update(id, generation, |entry| {
            entry.task.status = status;
            entry.task.code = Some(code.to_string());
            entry.task.resumable = status != ComputerTaskStatus::Completed;
        })?;
        self.task_event(&task);
        Ok(())
    }
    fn need_task_input(
        &self,
        id: &str,
        generation: u64,
        label: &str,
        choices: impl IntoIterator<Item = String>,
    ) -> Result<(), ComputerFailure> {
        let choices: Vec<String> = choices.into_iter().collect();
        let name = if label == "app" {
            "app"
        } else if label == "url" {
            "url"
        } else if choices.is_empty() {
            "text"
        } else {
            "target"
        };
        let task = self.tasks.update(id, generation, |entry| {
            entry.task.status = ComputerTaskStatus::NeedsInput;
            entry.task.resumable = true;
            entry.task.code = Some("missingInput".to_string());
            entry.task.summary = Some(match label {
                "url" => "The agent is waiting for a full URL. It will navigate after you supply it.",
                "text" => "The agent is waiting for caller-supplied text. It will type the text after you resume; you do not need to type into the app yourself.",
                "app" => "Choose the application the agent should use, then resume the task.",
                "target" => "Choose the intended control, then resume the task.",
                _ => "Supply the requested values, then resume the task.",
            }.to_string());
            entry.task.question = Some(match label {
                "url" => "Which full URL should the agent open?".to_string(),
                "text" => "What exact text should the agent type?".to_string(),
                _ => format!("Supply {} to continue this task.", pragma_core::computer::truncate_label(label)),
            });
            entry.task.requested_inputs =
                serde_json::from_value(json!([{ "name": name, "label": label, "secret": false,
                "kind": if choices.is_empty() { "text" } else { "choice" }, "options": choices }]))
                .unwrap_or_default();
        })?;
        self.task_event(&task);
        Ok(())
    }
    fn task_call(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        mut payload: Value,
    ) -> Result<Value, ComputerFailure> {
        payload["caller"] = super::to_value(caller)?;
        self.handle_rpc(host, payload)
    }
}
fn owns(caller: &ComputerCaller, task: &ComputerTask) -> Result<(), ComputerFailure> {
    if caller.kind == ComputerCallerKind::User || owner_key(caller) == owner_key(&task.owner) {
        Ok(())
    } else {
        Err(failure(
            ComputerErrorCode::NotAuthorized,
            "This task belongs to another caller",
        ))
    }
}
fn validate_values(
    instruction: &str,
    inputs: &HashMap<String, String>,
    secrets: &HashMap<String, String>,
) -> Result<(), ComputerFailure> {
    let limit = usize::try_from(CONSTANTS.computer.task_max_input_chars.get()).unwrap_or(16384);
    if instruction.len() > limit
        || inputs.len() + secrets.len() > 64
        || inputs
            .iter()
            .chain(secrets.iter())
            .any(|(name, value)| name.len() > 80 || name.is_empty() || value.len() > limit)
    {
        return Err(invalid("Computer task input exceeds its limits"));
    }
    Ok(())
}
