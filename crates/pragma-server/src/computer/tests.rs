//! The `computer` RPC end to end against the in-process fake backend:
//! enablement, policy and approvals, leases, sensitive controls, the stop,
//! and the activity every caller sees.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pragma_computer::fake::FakeBackend;
use pragma_computer::protocol::HelperOp;
use pragma_constants::{ComputerActivityType, ComputerErrorCode};
use serde_json::{json, Value};

use super::activity::ActivityBus;
use super::helper::InProcessHelper;
use super::{ComputerHost, ComputerService};

struct Host {
    desktop: AtomicBool,
}

impl ComputerHost for Host {
    fn desktop_connected(&self) -> bool {
        self.desktop.load(Ordering::SeqCst)
    }
    fn agent_for_tab(&self, _tab_id: &str) -> Option<String> {
        Some("claude-code".to_string())
    }
}

struct World {
    service: Arc<ComputerService>,
    host: Host,
    activity: Arc<ActivityBus>,
    log: Arc<std::sync::Mutex<Vec<String>>>,
    typing: Arc<AtomicBool>,
    permissions: Arc<std::sync::Mutex<Option<pragma_constants::ComputerPermissions>>>,
    home: tempfile::TempDir,
    server: tempfile::TempDir,
}

fn world(config: Option<Value>) -> World {
    let home = tempfile::tempdir().unwrap();
    if let Some(config) = config {
        std::fs::create_dir_all(home.path().join(".pragma")).unwrap();
        std::fs::write(home.path().join(".pragma/config.json"), config.to_string()).unwrap();
    }
    let server = tempfile::tempdir().unwrap();
    let backend = FakeBackend::default();
    let log = Arc::clone(&backend.log);
    let typing = Arc::clone(&backend.typing);
    let permissions = Arc::clone(&backend.permissions);
    let helper = Arc::new(InProcessHelper::new(
        Box::new(backend),
        // The same directory the real helper writes to, so the sweep sees it.
        server
            .path()
            .join(&pragma_constants::CONSTANTS.computer.screenshots_directory),
    ));
    let activity = Arc::new(ActivityBus::default());
    let service = ComputerService::with_helper(
        server.path(),
        helper,
        Arc::clone(&activity),
        Some(home.path().to_path_buf()),
    );
    World {
        service,
        host: Host {
            desktop: AtomicBool::new(true),
        },
        activity,
        log,
        typing,
        permissions,
        home,
        server,
    }
}

fn enabled_allowing_agents() -> Value {
    json!({ "computerUse": { "enabled": true, "access": { "agents": { "*": "allow" }, "sensitive": "allow" } } })
}

fn agent(tab: &str) -> Value {
    json!({ "kind": "agentTab", "tabId": tab, "worktreeId": "wt-1" })
}

fn user() -> Value {
    json!({ "kind": "user" })
}

impl World {
    fn call(
        &self,
        caller: &Value,
        mut request: Value,
    ) -> Result<Value, pragma_constants::ComputerFailure> {
        request["caller"] = caller.clone();
        self.service.handle_rpc(&self.host, request)
    }

    fn code(&self, caller: &Value, request: Value) -> ComputerErrorCode {
        self.call(caller, request).unwrap_err().code
    }

    fn kinds(&self) -> Vec<ComputerActivityType> {
        self.activity
            .history()
            .into_iter()
            .map(|event| event.type_)
            .collect()
    }

    fn element(&self, caller: &Value, label: &str) -> String {
        let snapshot = self
            .call(caller, json!({ "op": "inspect", "app": "TextEdit" }))
            .unwrap();
        snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|element| element["label"] == label)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

#[test]
fn computer_use_is_off_until_enabled() {
    let w = world(None);
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::Disabled
    );
    // Diagnostics still work while it is off.
    assert!(w.call(&agent("t1"), json!({ "op": "status" })).is_ok());
    assert!(w.call(&agent("t1"), json!({ "op": "permissions" })).is_ok());
}

#[test]
fn an_allowed_agent_clicks_by_element_and_everyone_sees_it() {
    let w = world(Some(enabled_allowing_agents()));
    let save = w.element(&agent("t1"), "Save");
    let result = w
        .call(&agent("t1"), json!({ "op": "click", "element": save }))
        .unwrap();
    assert_eq!(result["method"], "ax");
    assert_eq!(result["physicalCursor"], false);
    assert_eq!(w.log.lock().unwrap().as_slice(), ["click Save"]);
    let kinds = w.kinds();
    assert!(kinds.contains(&ComputerActivityType::SessionStarted));
    assert!(kinds.contains(&ComputerActivityType::ActionStarted));
    assert!(kinds.contains(&ComputerActivityType::ActionCompleted));
    let started = w
        .activity
        .history()
        .into_iter()
        .find(|event| event.type_ == ComputerActivityType::ActionStarted)
        .unwrap();
    assert_eq!(started.description.as_deref(), Some("Click “Save”"));
    assert!(
        started.pointer.is_some(),
        "the overlay cursor gets a destination"
    );
    let status = w.call(&agent("t1"), json!({ "op": "status" })).unwrap();
    assert_eq!(status["sessions"][0]["leases"][0]["appName"], "TextEdit");
    assert_eq!(status["sessions"][0]["owner"]["agentId"], "claude-code");
}

#[test]
fn typed_text_never_reaches_activity() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "type", "app": "TextEdit", "text": "hunter2" }),
    )
    .unwrap();
    let history = serde_json::to_string(&w.activity.history()).unwrap();
    assert!(!history.contains("hunter2"));
    assert!(history.contains("•••• (7 chars)"));
}

#[test]
fn a_second_agent_cannot_take_a_leased_app() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
    )
    .unwrap();
    let busy = w
        .call(
            &agent("t2"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
        )
        .unwrap_err();
    assert_eq!(busy.code, ComputerErrorCode::AppBusy);
    assert!(busy.retryable);
    assert!(w.kinds().contains(&ComputerActivityType::LeaseDenied));
    // A different app is fine, and ending the first session frees TextEdit.
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "Safari", "chords": ["mod+l"] }),
    )
    .unwrap();
    let ended = w.call(&agent("t1"), json!({ "op": "end" })).unwrap();
    assert_eq!(ended["ended"], true);
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["mod+s"] }),
    )
    .unwrap();
}

#[test]
fn acting_needs_the_desktop_but_reading_does_not() {
    let w = world(Some(enabled_allowing_agents()));
    w.host.desktop.store(false, Ordering::SeqCst);
    assert!(w
        .call(&agent("t1"), json!({ "op": "inspect", "app": "TextEdit" }))
        .is_ok());
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "click", "x": 150, "y": 130 })),
        ComputerErrorCode::IndicatorUnavailable
    );
}

#[test]
fn missing_native_grants_prompt_before_resolving_even_for_allowed_callers() {
    for access in ["ask", "allow"] {
        let w = Arc::new(world(Some(json!({
            "computerUse": { "enabled": true, "access": { "agents": { "*": access } } }
        }))));
        let denied = pragma_constants::ComputerPermissions {
            platform: "macos".to_string(),
            supported: true,
            accessibility: pragma_constants::ComputerPermissionState::Denied,
            screen_recording: pragma_constants::ComputerPermissionState::Denied,
        };
        *w.permissions.lock().unwrap() = Some(denied.clone());
        let asking = {
            let w = Arc::clone(&w);
            std::thread::spawn(move || {
                w.call(
                    &agent("first-use"),
                    json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
                )
            })
        };
        let started = std::time::Instant::now();
        let approval = loop {
            let pending = w.service.policy.pending();
            if let Some(approval) = pending.first() {
                break approval.clone();
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(5),
                "missing permission setup prompt"
            );
            std::thread::yield_now();
        };
        assert!(w.log.lock().unwrap().is_empty());
        assert_eq!(w.service.snapshot(&w.host).sessions, Vec::new());
        assert!(!asking.is_finished());
        // OS grants alone do not authorize the waiting operation.
        *w.permissions.lock().unwrap() = Some(pragma_constants::ComputerPermissions {
            accessibility: pragma_constants::ComputerPermissionState::Granted,
            screen_recording: pragma_constants::ComputerPermissionState::Granted,
            ..denied
        });
        assert!(!asking.is_finished());
        w.call(
            &user(),
            json!({ "op": "approve", "approval": approval.id, "decision": "session" }),
        )
        .unwrap();
        asking.join().unwrap().unwrap();
        // The same caller does not get a second approval after setup.
        w.call(&agent("first-use"), json!({ "op": "apps" }))
            .unwrap();
        assert_eq!(w.service.policy.pending(), Vec::new());
    }
}

#[test]
fn saved_always_allow_does_not_skip_native_permission_setup() {
    let w = Arc::new(world(Some(json!({ "computerUse": { "enabled": true } }))));
    let wait_for_approval = |service: &ComputerService| {
        let started = std::time::Instant::now();
        loop {
            if let Some(approval) = service.policy.pending().first() {
                break approval.clone();
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(5),
                "missing approval"
            );
            std::thread::yield_now();
        }
    };
    // Save an actual Always allow decision while the native grants are present.
    let first = {
        let w = Arc::clone(&w);
        std::thread::spawn(move || w.call(&agent("original-tab"), json!({ "op": "apps" })))
    };
    let approval = wait_for_approval(&w.service);
    w.call(
        &user(),
        json!({ "op": "approve", "approval": approval.id, "decision": "always" }),
    )
    .unwrap();
    first.join().unwrap().unwrap();
    // Reload that grant from disk, then simulate OS permissions being revoked.
    let mut backend = FakeBackend::default();
    backend.permissions = Arc::clone(&w.permissions);
    let helper = Arc::new(InProcessHelper::new(
        Box::new(backend),
        w.server
            .path()
            .join(&pragma_constants::CONSTANTS.computer.screenshots_directory),
    ));
    let restarted = ComputerService::with_helper(
        w.server.path(),
        helper,
        Arc::clone(&w.activity),
        Some(w.home.path().to_path_buf()),
    );
    *w.permissions.lock().unwrap() = Some(pragma_constants::ComputerPermissions {
        platform: "macos".to_string(),
        supported: true,
        accessibility: pragma_constants::ComputerPermissionState::Denied,
        screen_recording: pragma_constants::ComputerPermissionState::Denied,
    });
    let caller = agent("new-tab");
    let request = {
        let service = Arc::clone(&restarted);
        let caller = caller.clone();
        std::thread::spawn(move || {
            service.handle_rpc(
                &Host {
                    desktop: AtomicBool::new(true),
                },
                json!({ "op": "apps", "caller": caller }),
            )
        })
    };
    let approval = wait_for_approval(&restarted);
    assert_eq!(approval.caller.tab_id.as_deref(), Some("new-tab"));
    assert!(!request.is_finished());
    // Native setup can still be declined without revoking the saved Pragma grant.
    restarted.handle_rpc(&w.host, json!({ "op": "approve", "caller": user(), "approval": approval.id, "decision": "deny" })).unwrap();
    assert_eq!(
        request.join().unwrap().unwrap_err().code,
        ComputerErrorCode::Denied
    );
    let resolved = super::resolve_caller(&w.host, serde_json::from_value(caller).ok());
    assert_eq!(
        restarted.policy.access(&restarted.settings(), &resolved),
        pragma_constants::ComputerAccess::Allow
    );
}

#[test]
fn a_denied_caller_does_not_raise_permission_setup() {
    let w = world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "agents": { "*": "deny" } } } }),
    ));
    *w.permissions.lock().unwrap() = Some(pragma_constants::ComputerPermissions {
        platform: "macos".to_string(),
        supported: true,
        accessibility: pragma_constants::ComputerPermissionState::Denied,
        screen_recording: pragma_constants::ComputerPermissionState::Denied,
    });
    assert_eq!(
        w.code(&agent("denied"), json!({ "op": "apps" })),
        ComputerErrorCode::NotAuthorized
    );
    assert_eq!(w.service.policy.pending(), Vec::new());
}

#[test]
fn ask_waits_for_the_desktop_user_and_a_session_grant_sticks() {
    let w = Arc::new(world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "sensitive": "allow" } } }),
    )));
    let caller = agent("t1");
    let asking = {
        let w = Arc::clone(&w);
        let caller = caller.clone();
        std::thread::spawn(move || {
            w.call(
                &caller,
                json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
            )
        })
    };
    let approval = loop {
        let status = w.call(&user(), json!({ "op": "status" })).unwrap();
        if let Some(approval) = status["approvals"]
            .as_array()
            .and_then(|a| a.first())
            .cloned()
        {
            break approval;
        }
        std::thread::yield_now();
    };
    assert_eq!(approval["caller"]["agentId"], "claude-code");
    assert_eq!(approval["sensitive"], false);
    // The agent cannot answer its own prompt.
    assert_eq!(
        w.code(
            &caller,
            json!({ "op": "approve", "approval": approval["id"], "decision": "once" })
        ),
        ComputerErrorCode::NotAuthorized
    );
    w.call(
        &user(),
        json!({ "op": "approve", "approval": approval["id"], "decision": "session" }),
    )
    .unwrap();
    asking.join().unwrap().unwrap();
    // Allowed for the session: the next call does not ask again.
    w.call(
        &caller,
        json!({ "op": "key", "app": "TextEdit", "chords": ["tab"] }),
    )
    .unwrap();
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["approvals"],
        json!([])
    );
}

#[test]
fn ask_without_a_desktop_is_refused_not_hung() {
    let w = world(Some(json!({ "computerUse": { "enabled": true } })));
    w.host.desktop.store(false, Ordering::SeqCst);
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::NotAuthorized
    );
}

#[test]
fn denied_agents_are_refused() {
    let w = world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "agents": { "claude-code": "deny" } } } }),
    ));
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "apps" })),
        ComputerErrorCode::NotAuthorized
    );
}

#[test]
fn sensitive_controls_need_approval_even_for_allowed_agents() {
    let w = Arc::new(world(Some(
        json!({ "computerUse": { "enabled": true, "access": { "agents": { "*": "allow" } } } }),
    )));
    let delete = w.element(&agent("t1"), "Delete");
    let clicking = {
        let w = Arc::clone(&w);
        std::thread::spawn(move || {
            w.call(&agent("t1"), json!({ "op": "click", "element": delete }))
        })
    };
    let approval = loop {
        let status = w.call(&user(), json!({ "op": "status" })).unwrap();
        if let Some(approval) = status["approvals"]
            .as_array()
            .and_then(|a| a.first())
            .cloned()
        {
            break approval;
        }
        std::thread::yield_now();
    };
    assert!(approval["reason"].as_str().unwrap().contains("Delete"));
    assert_eq!(approval["sensitive"], true);
    w.call(
        &user(),
        json!({ "op": "approve", "approval": approval["id"], "decision": "deny" }),
    )
    .unwrap();
    assert_eq!(
        clicking.join().unwrap().unwrap_err().code,
        ComputerErrorCode::Denied
    );
    assert_eq!(
        *w.log.lock().unwrap(),
        Vec::<String>::new(),
        "nothing was clicked"
    );
}

#[test]
fn the_stop_ends_everything_until_unpaused() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "stop" })),
        ComputerErrorCode::NotAuthorized
    );
    w.call(&user(), json!({ "op": "stop" })).unwrap();
    let status = w.call(&user(), json!({ "op": "status" })).unwrap();
    assert_eq!(status["stopped"], true);
    assert_eq!(status["sessions"], json!([]));
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] })
        ),
        ComputerErrorCode::Stopped
    );
    w.call(&user(), json!({ "op": "unpause" })).unwrap();
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
}

#[test]
fn takeover_is_scoped_to_the_target_app_and_stays_paused() {
    let w = world(Some(enabled_allowing_agents()));
    w.typing.store(true, Ordering::SeqCst);
    let error = w
        .call(
            &agent("t1"),
            json!({"op":"key","app":"TextEdit","chords":["enter"]}),
        )
        .unwrap_err();
    assert_eq!(error.code, ComputerErrorCode::UserTakeover);
    assert!(error.message.contains("Please ask the user to resume"));
    // A different caller working in another app is unaffected.
    w.call(
        &agent("t2"),
        json!({"op":"key","app":"Safari","chords":["enter"]}),
    )
    .unwrap();
    w.typing.store(false, Ordering::SeqCst);
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({"op":"key","app":"TextEdit","chords":["enter"]})
        ),
        ComputerErrorCode::UserTakeover
    );
    w.call(&user(), json!({"op":"unpause"})).unwrap();
    w.call(
        &agent("t1"),
        json!({"op":"key","app":"TextEdit","chords":["enter"]}),
    )
    .unwrap();
}

#[test]
fn a_paused_session_refuses_actions() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    w.call(&user(), json!({ "op": "pause" })).unwrap();
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] })
        ),
        ComputerErrorCode::UserTakeover
    );
    w.call(&user(), json!({ "op": "unpause" })).unwrap();
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
}

#[test]
fn idle_sessions_and_closed_tabs_end() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    w.call(
        &agent("t2"),
        json!({ "op": "key", "app": "Safari", "chords": ["enter"] }),
    )
    .unwrap();
    w.service.end_tab("t2");
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    w.service.sweep_idle(super::now_ms() + 10 * 60 * 1000);
    assert_eq!(
        w.call(&user(), json!({ "op": "status" })).unwrap()["sessions"],
        json!([])
    );
}

#[test]
fn image_coordinates_map_through_a_known_screenshot() {
    let w = world(Some(enabled_allowing_agents()));
    let shot = w
        .call(
            &agent("t1"),
            json!({ "op": "screenshot", "app": "TextEdit" }),
        )
        .unwrap();
    // The fake's screenshot has origin (100,100) and scale 2.
    w.call(
        &agent("t1"),
        json!({ "op": "click", "app": "TextEdit", "imageX": 40, "imageY": 20, "screenshot": shot["id"] }),
    )
    .unwrap();
    assert_eq!(w.log.lock().unwrap().as_slice(), ["click 120,110"]);
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "click", "imageX": 1, "imageY": 1, "screenshot": "shot_nope" })
        ),
        ComputerErrorCode::SnapshotExpired
    );
}

#[test]
fn bad_payloads_are_typed() {
    let w = world(Some(enabled_allowing_agents()));
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "fly" })),
        ComputerErrorCode::InvalidPayload
    );
    assert_eq!(
        w.code(&agent("t1"), json!({ "op": "click", "bogus": 1 })),
        ComputerErrorCode::InvalidPayload
    );
}

#[test]
fn opening_an_app_makes_preview_frames_available_without_input() {
    let w = world(Some(enabled_allowing_agents()));
    let opened = w
        .call(&agent("t1"), json!({ "op": "open", "app": "TextEdit" }))
        .unwrap();
    let before = w.service.snapshot(&w.host);
    let frame = w
        .call(
            &user(),
            json!({ "op": "frame", "session": opened["sessionId"], "maxWidth": 480 }),
        )
        .unwrap();
    assert!(frame["base64"]
        .as_str()
        .is_some_and(|bytes| !bytes.is_empty()));
    assert_eq!(w.log.lock().unwrap().as_slice(), ["open TextEdit"]);
    assert_eq!(w.service.snapshot(&w.host).sessions, before.sessions);
    assert_eq!(w.activity.last_seq(), before.last_seq);
}

#[test]
fn only_the_desktop_reads_session_frames() {
    let w = world(Some(enabled_allowing_agents()));
    let done = w
        .call(
            &agent("t1"),
            json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
        )
        .unwrap();
    let session = done["sessionId"].clone();
    assert_eq!(
        w.code(&agent("t2"), json!({ "op": "frame", "session": session })),
        ComputerErrorCode::NotAuthorized
    );
    let frame = w
        .call(&user(), json!({ "op": "frame", "session": session }))
        .unwrap();
    assert_eq!(frame["format"], "png");
}

#[test]
fn old_screenshots_are_swept() {
    let w = world(Some(enabled_allowing_agents()));
    let shot = w
        .call(
            &agent("t1"),
            json!({ "op": "screenshot", "app": "TextEdit" }),
        )
        .unwrap();
    let path = std::path::PathBuf::from(shot["path"].as_str().unwrap());
    w.service.sweep_screenshots(std::time::SystemTime::now());
    assert!(path.exists(), "a fresh screenshot is kept");
    w.service
        .sweep_screenshots(std::time::SystemTime::now() + std::time::Duration::from_hours(48));
    assert!(!path.exists(), "a day-old screenshot is deleted");
}

fn task_host(world: &World) -> Arc<Host> {
    let host = Arc::new(Host {
        desktop: AtomicBool::new(true),
    });
    world.service.attach_host(&host);
    host
}

fn wait_task(world: &World, owner: &Value, id: &str) -> Value {
    let start = std::time::Instant::now();
    loop {
        let task = world.call(owner, json!({"op":"task","taskId":id})).unwrap();
        if task["status"] != "running" && task["status"] != "needsApproval" {
            return task;
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "task did not settle: {task}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn computer_task_pauses_for_app_and_resumes_an_exact_click_without_a_model() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let owner = agent("task-owner");
    let request = json!({"op":"run","requestId":"retry-id","instruction":"click \"Save\""});
    let task = world.call(&owner, request.clone()).unwrap();
    let id = task["id"].as_str().unwrap();
    assert_eq!(world.call(&owner, request).unwrap()["id"], id);
    let task = wait_task(&world, &owner, id);
    assert_eq!(task["status"], "needsInput");
    assert_eq!(task["requestedInputs"][0]["name"], "app");
    std::thread::sleep(std::time::Duration::from_millis(20));
    world
        .call(
            &owner,
            json!({"op":"resume","taskId":id,"inputs":{"app":"TextEdit"}}),
        )
        .unwrap();
    let done = wait_task(&world, &owner, id);
    assert_eq!(done["status"], "completed");
    assert_eq!(done["modelCalls"], 0);
    assert!(world
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|line| line.contains("click")));
}

#[test]
fn computer_task_cancellation_is_owned_and_generation_checked() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let task = world
        .call(
            &agent("owner"),
            json!({"op":"run","requestId":"cancel","instruction":"do something"}),
        )
        .unwrap();
    let id = task["id"].as_str().unwrap();
    assert_eq!(
        world.code(&agent("other"), json!({"op":"cancel","taskId":id})),
        ComputerErrorCode::NotAuthorized
    );
    world
        .call(&agent("owner"), json!({"op":"cancel","taskId":id}))
        .unwrap();
    assert_eq!(
        world.code(
            &agent("owner"),
            json!({"op":"click","element":"s1:e0","task":{"id":id,"generation":0}})
        ),
        ComputerErrorCode::Stopped
    );
    assert_eq!(
        world
            .call(&agent("owner"), json!({"op":"task","taskId":id}))
            .unwrap()["status"],
        "cancelled"
    );
}

#[test]
fn computer_task_records_exclude_secrets_and_recover_as_interrupted() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let task = world.call(&agent("owner"),json!({"op":"run","requestId":"secrets","instruction":"use token NEVER_PERSIST_ME","secrets":{"token":"NEVER_PERSIST_ME"}})).unwrap();
    let id = task["id"].as_str().unwrap();
    wait_task(&world, &agent("owner"), id);
    let path = world
        .server
        .path()
        .join(&pragma_constants::CONSTANTS.computer.tasks_file);
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("NEVER_PERSIST_ME"));
    let recovered = super::tasks::Tasks::load(world.server.path()).all();
    assert_eq!(recovered[0].code.as_deref(), Some("interrupted"));
    assert!(recovered[0].resumable);
}

#[test]
fn computer_task_resume_rejects_cumulative_input_without_changing_the_task() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let owner = agent("input-limits");
    let limit = usize::try_from(
        pragma_constants::CONSTANTS
            .computer
            .task_max_input_chars
            .get(),
    )
    .unwrap();
    let task = world
        .call(
            &owner,
            json!({"op":"run","requestId":"input-limits","instruction":"x".repeat(limit),"inputs":{"text":"original"}}),
        )
        .unwrap();
    let id = task["id"].as_str().unwrap();
    let before = wait_task(&world, &owner, id);
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(
        world.code(
            &owner,
            json!({"op":"resume","taskId":id,"note":"more", "inputs":{"app":"TextEdit"}})
        ),
        ComputerErrorCode::InvalidPayload
    );
    let after = world
        .call(&owner, json!({"op":"task","taskId":id}))
        .unwrap();
    assert_eq!(before["instruction"], after["instruction"]);
    assert_eq!(before["app"], after["app"]);
    assert_eq!(before["variableNames"], after["variableNames"]);
}

#[test]
fn computer_task_recipes_verify_navigation_and_literal_fill_without_a_model() {
    for (app, instruction) in [
        ("Safari", "Open Safari and navigate to https://example.com"),
        ("TextEdit", "type \"héllo\""),
    ] {
        let world = world(Some(enabled_allowing_agents()));
        let _host = task_host(&world);
        let owner = agent("recipe");
        let task = world
            .call(
                &owner,
                json!({"op":"run","requestId":"recipe","instruction":instruction,"app":app}),
            )
            .unwrap();
        let task = wait_task(&world, &owner, task["id"].as_str().unwrap());
        assert_eq!(task["status"], "completed", "{task}");
        assert_eq!(task["modelCalls"], 0);
    }
}

#[test]
fn computer_task_navigation_requests_a_url_then_resumes_without_a_model() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let owner = agent("navigation-input");
    let task = world
        .call(
            &owner,
            json!({"op":"run","requestId":"youtube", "app":"Safari",
        "instruction":"Open safari and navigate to youtube"}),
        )
        .unwrap();
    let id = task["id"].as_str().unwrap();
    let waiting = wait_task(&world, &owner, id);
    assert_eq!(waiting["status"], "needsInput");
    assert_eq!(waiting["requestedInputs"][0]["name"], "url");
    assert_eq!(waiting["question"], "Which full URL should the agent open?");
    assert_eq!(waiting["modelCalls"], 0);
    std::thread::sleep(std::time::Duration::from_millis(20));
    world
        .call(
            &owner,
            json!({"op":"resume","taskId":id,"inputs":{"url":"https://www.youtube.com"}}),
        )
        .unwrap();
    let done = wait_task(&world, &owner, id);
    assert_eq!(done["status"], "completed");
    assert_eq!(done["modelCalls"], 0);
    assert!(done.get("question").is_none_or(Value::is_null));
    assert!(done.get("summary").is_none_or(Value::is_null));
}

#[test]
fn computer_task_missing_text_is_a_clear_resumable_input_request() {
    let world = world(Some(enabled_allowing_agents()));
    let _host = task_host(&world);
    let owner = agent("text-input");
    let task = world
        .call(
            &owner,
            json!({"op":"run","requestId":"text", "app":"TextEdit",
        "instruction":"fill focused"}),
        )
        .unwrap();
    let waiting = wait_task(&world, &owner, task["id"].as_str().unwrap());
    assert_eq!(waiting["status"], "needsInput");
    assert_eq!(waiting["requestedInputs"][0]["name"], "text");
    assert_eq!(
        waiting["question"],
        "What exact text should the agent type?"
    );
    assert!(waiting["summary"]
        .as_str()
        .unwrap()
        .contains("you do not need to type into the app yourself"));
    assert_eq!(waiting["resumable"], true);
    assert_eq!(waiting["modelCalls"], 0);
}

#[test]
fn desktop_focuses_the_previewed_app_without_changing_a_paused_agent_session() {
    let w = world(Some(enabled_allowing_agents()));
    let done = w
        .call(
            &agent("t1"),
            json!({"op":"key","app":"TextEdit","chords":["enter"]}),
        )
        .unwrap();
    let id = done["sessionId"].clone();
    w.call(&user(), json!({"op":"pause","session":id})).unwrap();
    let before = w.service.snapshot(&w.host).sessions;
    let focused = w
        .call(&user(), json!({"op":"focusSession","session":id}))
        .unwrap();
    assert_eq!(focused["app"]["name"], "TextEdit");
    assert!(w
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|entry| entry == "focus TextEdit to front"));
    assert_eq!(w.service.snapshot(&w.host).sessions, before);
    assert_eq!(
        w.code(&agent("t2"), json!({"op":"focusSession","session":id})),
        ComputerErrorCode::NotAuthorized
    );
    assert_eq!(
        w.code(
            &json!({"kind":"sdk"}),
            json!({"op":"focusSession","session":id})
        ),
        ComputerErrorCode::NotAuthorized
    );
}

#[test]
fn session_focus_requires_a_live_session_and_respects_the_stop() {
    let w = world(Some(enabled_allowing_agents()));
    assert_eq!(
        w.code(&user(), json!({"op":"focusSession"})),
        ComputerErrorCode::InvalidPayload
    );
    assert_eq!(
        w.code(&user(), json!({"op":"focusSession","session":"missing"})),
        ComputerErrorCode::WindowNotFound
    );
    w.call(&user(), json!({"op":"stop"})).unwrap();
    assert_eq!(
        w.code(&user(), json!({"op":"focusSession","session":"missing"})),
        ComputerErrorCode::Stopped
    );
    assert!(!w
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|entry| entry.starts_with("focus ")));
}

#[test]
fn agents_never_bring_an_app_to_the_front() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({"op":"open","app":"TextEdit","activate":true}),
    )
    .unwrap();
    w.call(
        &agent("t1"),
        json!({"op":"focus","app":"TextEdit","activate":true}),
    )
    .unwrap();
    assert_eq!(
        w.log.lock().unwrap().as_slice(),
        ["open TextEdit", "focus TextEdit"]
    );
}

#[test]
fn session_stop_requires_user_restart_and_releases_its_app() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({"op":"key","app":"TextEdit","chords":["enter"]}),
    )
    .unwrap();
    let status = w.call(&user(), json!({"op":"status"})).unwrap();
    let id = &status["sessions"][0]["id"];
    w.call(&user(), json!({"op":"stop","session":id})).unwrap();
    w.service.sweep_idle(u64::MAX);
    for op in [
        json!({"op":"key","app":"TextEdit","chords":["enter"]}),
        json!({"op":"end"}),
        json!({"op":"run","requestId":"bypass","instruction":"do something"}),
    ] {
        let error = w.call(&agent("t1"), op).unwrap_err();
        assert_eq!(error.code, ComputerErrorCode::Stopped);
        assert!(error.message.contains("Please ask the user to restart"));
    }
    w.call(
        &agent("t2"),
        json!({"op":"key","app":"TextEdit","chords":["enter"]}),
    )
    .unwrap();
    w.call(&agent("t2"), json!({"op":"end"})).unwrap();
    w.call(&user(), json!({"op":"unpause","session":id}))
        .unwrap();
    w.call(
        &agent("t1"),
        json!({"op":"key","app":"TextEdit","chords":["enter"]}),
    )
    .unwrap();
    let status = w.call(&user(), json!({"op":"status"})).unwrap();
    assert_eq!(status["sessions"][0]["leases"].as_array().unwrap().len(), 1);
}

#[test]
fn pause_during_cursor_lead_prevents_the_native_action() {
    let w = world(Some(enabled_allowing_agents()));
    let save = w.element(&agent("t1"), "Save");
    let (service, activity) = (w.service.clone(), w.activity.clone());
    let host = Host {
        desktop: AtomicBool::new(true),
    };
    let worker = std::thread::spawn(move || {
        service.handle_rpc(
            &host,
            json!({"caller":agent("t1"),"op":"click","element":save}),
        )
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !activity
        .history()
        .iter()
        .any(|e| e.type_ == ComputerActivityType::ActionStarted)
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    w.call(&user(), json!({"op":"pause"})).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        ComputerErrorCode::UserTakeover
    );
    assert!(w.log.lock().unwrap().is_empty());
}

#[test]
fn desktop_pause_and_takeover_invalidate_running_task_generations() {
    for takeover in [false, true] {
        let w = world(Some(enabled_allowing_agents()));
        let _host = task_host(&w);
        let owner = agent("task-owner");
        let task = w.call(&owner, json!({"op":"run","requestId":"pause","instruction":"click \"Save\"","app":"TextEdit"})).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !w.activity.history().iter().any(|e| {
            e.type_ == ComputerActivityType::ActionStarted
                && e.op == Some(pragma_constants::ComputerOp::Click)
        }) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        if takeover {
            w.typing.store(true, Ordering::SeqCst);
            w.service.check_user_takeover();
        } else {
            w.call(&user(), json!({"op":"pause"})).unwrap();
        }
        let paused = wait_task(&w, &owner, task["id"].as_str().unwrap());
        assert_eq!(paused["status"], "paused");
        assert_eq!(paused["resumable"], true);
        std::thread::sleep(std::time::Duration::from_millis(250));
        assert!(w
            .log
            .lock()
            .unwrap()
            .iter()
            .all(|line| !line.starts_with("click")));
        assert_eq!(
            w.call(&owner, json!({"op":"task","taskId":task["id"]}))
                .unwrap()["status"],
            "paused"
        );
        w.typing.store(false, Ordering::SeqCst);
        assert_eq!(
            w.code(&owner, json!({"op":"resume","taskId":task["id"]})),
            ComputerErrorCode::UserTakeover
        );
        w.call(&user(), json!({"op":"unpause"})).unwrap();
        w.call(&owner, json!({"op":"resume","taskId":task["id"]}))
            .unwrap();
        assert_eq!(
            wait_task(&w, &owner, task["id"].as_str().unwrap())["status"],
            "completed"
        );
    }
}

#[test]
fn desktop_pause_or_stop_during_approval_preserves_the_user_outcome() {
    for (op, status) in [("pause", "paused"), ("stop", "cancelled")] {
        let w = world(Some(json!({"computerUse":{"enabled":true}})));
        let _host = task_host(&w);
        let owner = agent("approval-task");
        let task = w.call(&owner, json!({"op":"run","requestId":"approval","instruction":"click \"Save\"","app":"TextEdit"})).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while w.service.policy.pending().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        w.call(&user(), json!({"op":op,"session":task["sessionId"]}))
            .unwrap();
        assert_eq!(
            wait_task(&w, &owner, task["id"].as_str().unwrap())["status"],
            status
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(
            w.call(&owner, json!({"op":"task","taskId":task["id"]}))
                .unwrap()["status"],
            status
        );
        assert!(w.log.lock().unwrap().is_empty());
        assert!(w
            .call(&owner, json!({"op":"resume","taskId":task["id"]}))
            .unwrap_err()
            .message
            .contains("Please ask the user"));
    }
}

/// A cold `open` must outlive both its app-catalog lookup and its window wait.
/// Budgeting only the window wait let a slow Start-menu catalog push the helper
/// past the deadline, so the server killed a helper that was still working and
/// the caller saw `helperUnavailable` after a stray app launch.
#[test]
fn open_timeout_covers_the_catalog_and_the_window_wait() {
    let wait = 5_000_u64;
    let request = serde_json::from_value(json!({ "app": "notepad", "waitReadyMs": wait })).unwrap();
    let timeout = super::timeout_for(&HelperOp::Open(request));
    let budget = wait
        + pragma_constants::CONSTANTS
            .computer
            .app_launch_wait_ms
            .get()
        + pragma_constants::CONSTANTS.computer.action_timeout_ms.get();
    assert!(timeout >= std::time::Duration::from_millis(budget));
}

fn blocking_safari() -> Value {
    json!({ "computerUse": {
        "enabled": true,
        "access": { "agents": { "*": "allow" }, "sensitive": "allow" },
        "blockedApps": ["mac:com.apple.safari"],
    } })
}

#[test]
fn a_blocked_window_cannot_be_captured_by_id() {
    let w = world(Some(blocking_safari()));
    let safari_window = json!({ "op": "screenshot", "window": "win:mac:4343" });
    assert_eq!(
        w.code(&agent("t1"), safari_window),
        ComputerErrorCode::BlockedApp
    );
    // An allowed app named alongside does not vouch for another app's window.
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "screenshot", "app": "TextEdit", "window": "win:mac:4343" })
        ),
        ComputerErrorCode::BlockedApp
    );
    w.call(
        &agent("t1"),
        json!({ "op": "screenshot", "window": "win:mac:4242" }),
    )
    .unwrap();
}

#[test]
fn a_window_must_belong_to_the_app_named_with_it() {
    let w = world(Some(enabled_allowing_agents()));
    assert_eq!(
        w.code(
            &agent("t1"),
            json!({ "op": "screenshot", "app": "TextEdit", "window": "win:mac:4343" })
        ),
        ComputerErrorCode::InvalidPayload
    );
}

#[test]
fn screen_captures_leave_out_blocked_apps() {
    let w = world(Some(blocking_safari()));
    for request in [
        json!({ "op": "screenshot" }),
        json!({ "op": "screenshot", "display": "display:mac:1" }),
        // A region wins over a window in every backend, so it is a screen capture.
        json!({ "op": "screenshot", "window": "win:mac:4242", "region": { "x": 0, "y": 0, "w": 10, "h": 10 } }),
    ] {
        w.log.lock().unwrap().clear();
        w.call(&agent("t1"), request).unwrap();
        assert_eq!(
            w.log.lock().unwrap().as_slice(),
            ["screenshot hiding [4343]"]
        );
    }
}

#[test]
fn untargeted_input_goes_to_the_app_that_was_checked() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(&agent("t1"), json!({ "op": "key", "chords": ["enter"] }))
        .unwrap();
    assert_eq!(w.log.lock().unwrap().as_slice(), ["key enter @4242"]);
}

#[test]
fn ending_a_session_stops_its_native_work() {
    let w = world(Some(enabled_allowing_agents()));
    w.call(
        &agent("t1"),
        json!({ "op": "key", "app": "TextEdit", "chords": ["enter"] }),
    )
    .unwrap();
    let session = w.call(&user(), json!({ "op": "status" })).unwrap()["sessions"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    w.service.end_tab("t1");
    // An action still dispatched under the ended session is refused by the helper.
    let stale = w.service.helper_call(HelperOp::InSession {
        session: session.clone(),
        pid: None,
        action: Box::new(HelperOp::Ping),
    });
    assert_eq!(stale.unwrap_err().code, ComputerErrorCode::UserTakeover);
    assert_eq!(
        w.service.require_live_session(&session).unwrap_err().code,
        ComputerErrorCode::Stopped
    );
}

#[test]
fn subscribing_never_loses_an_event_emitted_during_the_snapshot() {
    let bus = ActivityBus::default();
    let (_, events) = bus.subscribe(|| {
        bus.emit(super::activity::event(
            ComputerActivityType::ApprovalRequested,
        ));
        Value::Null
    });
    assert!(events.try_recv().is_ok());
}
