//! Supervision of the `pragma-computer` helper process.
//!
//! The helper owns every native call; this side owns its lifetime. It is
//! started on first use, spoken to in NDJSON over its standard streams
//! (`pragma_computer::protocol`), and restarted with backoff when it dies. A
//! crash fails only the in-flight request, as `helperUnavailable` with
//! `retryable: true`. Closing its stdin — which happens when this server exits
//! — is what tells it to exit, exactly like the Bun sidecars.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pragma_computer::protocol::{HelperHello, HelperOp, HelperRequest, HelperResponse};
use pragma_computer::ComputerResult;
use pragma_constants::{
    ComputerErrorCode, ComputerHelperState, ComputerHelperStatus, ComputerPermissionState,
    ComputerPermissions, CONSTANTS,
};
use pragma_core::computer::failure;

/// Something that runs helper operations. The real one is a process; tests
/// use an in-process fake backend.
pub trait Helper: Send + Sync {
    /// Runs one operation, waiting at most `timeout`.
    fn call(&self, op: HelperOp, timeout: Duration) -> ComputerResult<serde_json::Value>;
    /// Latches (or clears) the helper's emergency stop without queueing
    /// behind a running action.
    fn set_stopped(&self, stopped: bool);
    /// Interrupts a session's in-flight input without queueing behind it.
    fn set_session_paused(&self, session: &str, paused: bool);
    /// The helper's health.
    fn status(&self) -> ComputerHelperStatus;
}

/// Called whenever the helper's state changes, to publish `helperState`.
pub type StatusListener = Arc<dyn Fn(ComputerHelperStatus) + Send + Sync>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    reader: std::thread::JoinHandle<()>,
}

impl Running {
    fn shutdown(self) {
        let Self {
            mut child,
            stdin,
            reader,
        } = self;
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        // Drain the old reader before a replacement can register new requests.
        let _ = reader.join();
    }
}

/// The least time between two permission probes (see [`ProcessHelper::probe`]).
const PROBE_INTERVAL: Duration = Duration::from_secs(3);
/// How long a probe may take to answer before it is abandoned.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

fn should_refresh_permissions(
    op: &HelperOp,
    previous: Option<&ComputerPermissions>,
    idle: bool,
) -> bool {
    idle && matches!(op, HelperOp::Permissions(_))
        && previous.is_some_and(|p| {
            p.platform == "macos"
                && (p.accessibility != ComputerPermissionState::Granted
                    || p.screen_recording != ComputerPermissionState::Granted)
        })
}

struct Inner {
    running: Option<Running>,
    status: ComputerHelperStatus,
    /// Consecutive starts that ended in a crash; reset by a successful call.
    crashes: usize,
    /// When the last permission probe ran.
    last_probe: Option<Instant>,
}

/// The supervised helper process.
pub struct ProcessHelper {
    inner: Mutex<Inner>,
    pending: Arc<Mutex<HashMap<u64, Sender<HelperResponse>>>>,
    next_id: AtomicU64,
    screenshots_dir: PathBuf,
    listener: StatusListener,
}

fn status(state: ComputerHelperState, message: Option<String>) -> ComputerHelperStatus {
    ComputerHelperStatus {
        state,
        pid: None,
        message,
        permissions: None,
    }
}

fn unavailable(message: impl Into<String>) -> pragma_constants::ComputerFailure {
    failure(ComputerErrorCode::HelperUnavailable, message)
}

/// Where the helper binary lives: `PRAGMA_COMPUTER_HELPER` when set (tests,
/// local experiments), else beside this server executable, where both a dev
/// `cargo build` and the packaged app put it. When the macOS helper app
/// (`<macHelperAppName>.app`) sits there too, its executable wins: macOS
/// grants Accessibility and Screen Recording to an app bundle, while System
/// Settings refuses a bare ad hoc binary. Only macOS builds stage that bundle.
fn helper_path() -> PathBuf {
    if let Some(path) = std::env::var_os("PRAGMA_COMPUTER_HELPER") {
        return PathBuf::from(path);
    }
    let name = crate::sidecar::executable_name(&CONSTANTS.computer.helper_name);
    let bare = crate::sidecar::sidecar_executable(&name);
    let bundled = bare.parent().map(|dir| {
        dir.join(format!("{}.app", CONSTANTS.computer.mac_helper_app_name))
            .join("Contents")
            .join("MacOS")
            .join(&name)
    });
    let packaged = bare
        .parent()
        .and_then(std::path::Path::parent)
        .map(|contents| {
            contents
                .join("Helpers")
                .join(format!("{}.app", CONSTANTS.computer.mac_helper_app_name))
                .join("Contents/MacOS")
                .join(&name)
        });
    if let Some(path) = packaged.filter(|p| p.is_file()) {
        return path;
    }
    match bundled {
        Some(path) if path.is_file() => path,
        _ => bare,
    }
}

impl ProcessHelper {
    /// A helper that is not started until its first call.
    pub fn new(screenshots_dir: PathBuf, listener: StatusListener) -> Self {
        Self {
            inner: Mutex::new(Inner {
                running: None,
                status: status(ComputerHelperState::Stopped, None),
                crashes: 0,
                last_probe: None,
            }),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            screenshots_dir,
            listener,
        }
    }

    fn set_status(&self, inner: &mut Inner, next: ComputerHelperStatus) {
        if inner.status != next {
            inner.status = next.clone();
            (self.listener)(next);
        }
    }

    /// Starts the helper when it is not running, honouring the restart backoff.
    fn ensure_running(&self, inner: &mut Inner) -> ComputerResult<()> {
        if let Some(running) = inner.running.as_mut() {
            if let Ok(None) = running.child.try_wait() {
                return Ok(());
            }
            if let Some(running) = inner.running.take() {
                running.shutdown();
            }
            inner.crashes += 1;
        }
        let backoff = &CONSTANTS.computer.helper_restart_backoff_ms;
        if inner.crashes > backoff.len() {
            let message = "the computer-use helper keeps crashing".to_string();
            self.set_status(
                inner,
                status(ComputerHelperState::Unavailable, Some(message.clone())),
            );
            return Err(unavailable(message));
        }
        if inner.crashes > 0 {
            self.set_status(inner, status(ComputerHelperState::Restarting, None));
            std::thread::sleep(Duration::from_millis(backoff[inner.crashes - 1]));
        } else {
            self.set_status(inner, status(ComputerHelperState::Starting, None));
        }
        let running = self.spawn().inspect_err(|error| {
            self.set_status(
                inner,
                status(
                    ComputerHelperState::Unavailable,
                    Some(error.message.clone()),
                ),
            );
        })?;
        let mut ready = status(ComputerHelperState::Ready, None);
        ready.pid = Some(u64::from(running.child.id()));
        inner.running = Some(running);
        self.set_status(inner, ready);
        Ok(())
    }

    /// Asks a short-lived second helper (same app, so the same grants) for
    /// the current permissions; `None` when it does not answer in time.
    fn probe(&self) -> Option<ComputerPermissions> {
        let mut child = pragma_platform::process::command(helper_path())
            .arg("--screenshots-dir")
            .arg(&self.screenshots_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            // The hello line, then the answer.
            let answer = BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
                .find_map(|line| serde_json::from_str::<HelperResponse>(&line).ok());
            let _ = tx.send(answer);
        });
        let request = HelperRequest {
            id: 0,
            op: HelperOp::Permissions(pragma_constants::ComputerPermissionsRequest::default()),
        };
        let sent = serde_json::to_string(&request).is_ok_and(|line| {
            writeln!(stdin, "{line}")
                .and_then(|()| stdin.flush())
                .is_ok()
        });
        let answer = if sent {
            rx.recv_timeout(PROBE_TIMEOUT).ok().flatten()
        } else {
            None
        };
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        answer
            .and_then(|response| response.result)
            .and_then(|value| serde_json::from_value(value).ok())
    }

    fn spawn(&self) -> ComputerResult<Running> {
        let path = helper_path();
        let _ = pragma_platform::perms::create_private_dir(&self.screenshots_dir);
        let mut child = pragma_platform::process::command(&path)
            .arg("--screenshots-dir")
            .arg(&self.screenshots_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| unavailable(format!("could not start {}: {error}", path.display())))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| unavailable("helper stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| unavailable("helper stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| unavailable("helper stderr unavailable"))?;
        // A release helper is built with `panic = "abort"`, so a crash leaves no
        // trace unless its stderr is drained. Keep the last line to attach to the
        // failure every waiting call gets, and copy the rest to the server log.
        let last_error = Arc::new(Mutex::new(None::<String>));
        let stderr_last = Arc::clone(&last_error);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                eprintln!("pragma-computer: {line}");
                if let Ok(mut slot) = stderr_last.lock() {
                    *slot = Some(line);
                }
            }
        });
        let mut lines = BufReader::new(stdout).lines();
        let hello = lines
            .next()
            .and_then(Result::ok)
            .and_then(|line| serde_json::from_str::<HelperHello>(&line).ok())
            .filter(|hello| hello.ready);
        if hello.is_none() {
            let _ = child.kill();
            return Err(unavailable("the computer-use helper did not start"));
        }
        let pending = Arc::clone(&self.pending);
        let reader = std::thread::spawn(move || {
            for line in lines {
                let Ok(line) = line else { break };
                let Ok(response) = serde_json::from_str::<HelperResponse>(&line) else {
                    continue;
                };
                let waiter = pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&response.id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(response);
                }
            }
            // The helper is gone: fail everything still waiting on it, naming the
            // last thing it printed (a panic message is the usual case).
            let detail = last_error
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .map_or_else(String::new, |line| format!(": {line}"));
            let message = format!("the computer-use helper exited{detail}");
            if let Ok(mut pending) = pending.lock() {
                for (id, waiter) in pending.drain() {
                    let _ = waiter.send(HelperResponse::err(id, unavailable(message.clone())));
                }
            }
        });
        Ok(Running {
            child,
            stdin,
            reader,
        })
    }

    fn send(inner: &mut Inner, request: &HelperRequest) -> ComputerResult<()> {
        let line = serde_json::to_string(request)
            .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))?;
        let running = inner
            .running
            .as_mut()
            .ok_or_else(|| unavailable("the computer-use helper is not running"))?;
        writeln!(running.stdin, "{line}")
            .and_then(|()| running.stdin.flush())
            .map_err(|error| unavailable(format!("write to helper: {error}")))
    }
}

impl Helper for ProcessHelper {
    fn call(&self, op: HelperOp, timeout: Duration) -> ComputerResult<serde_json::Value> {
        let permissions = matches!(&op, HelperOp::Permissions(_));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let process_id;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| unavailable("helper lock poisoned"))?;
            let idle = self.pending.lock().is_ok_and(|pending| pending.is_empty());
            if should_refresh_permissions(&op, inner.status.permissions.as_ref(), idle)
                && inner
                    .last_probe
                    .is_none_or(|at| at.elapsed() >= PROBE_INTERVAL)
            {
                // macOS caches a denied grant for the life of a process, so the
                // live helper cannot see a new one. A restart drops every
                // element snapshot and background focus, though, and the
                // preview and Settings check often: ask a fresh process, and
                // restart only when the grants really changed.
                inner.last_probe = Some(Instant::now());
                let changed = self.probe().is_some_and(|fresh| {
                    inner.status.permissions.as_ref().is_some_and(|known| {
                        fresh.accessibility != known.accessibility
                            || fresh.screen_recording != known.screen_recording
                    })
                });
                if changed {
                    if let Some(running) = inner.running.take() {
                        running.shutdown();
                    }
                    inner.crashes = 0;
                }
            }
            self.ensure_running(&mut inner)?;
            process_id = inner.running.as_ref().map(|running| running.child.id());
            if let Ok(mut pending) = self.pending.lock() {
                pending.insert(id, tx);
            }
            if let Err(error) = Self::send(&mut inner, &HelperRequest { id, op }) {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(error);
            }
        }
        let Ok(response) = rx.recv_timeout(timeout) else {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            // A helper that does not answer is wedged in a native call;
            // restarting it is the only way to get the next call through.
            if let Ok(mut inner) = self.inner.lock() {
                if inner.running.as_ref().map(|running| running.child.id()) == process_id {
                    if let Some(running) = inner.running.take() {
                        running.shutdown();
                    }
                }
            }
            return Err(failure(
                ComputerErrorCode::Timeout,
                "the computer-use helper did not answer in time",
            ));
        };
        if response.ok {
            if let Ok(mut inner) = self.inner.lock() {
                if inner.running.as_ref().map(|running| running.child.id()) == process_id {
                    inner.crashes = 0;
                }
                if permissions
                    && inner.running.as_ref().map(|running| running.child.id()) == process_id
                {
                    let mut next = inner.status.clone();
                    next.permissions = response
                        .result
                        .as_ref()
                        .and_then(|v| serde_json::from_value(v.clone()).ok());
                    self.set_status(&mut inner, next);
                }
            }
            Ok(response.result.unwrap_or(serde_json::Value::Null))
        } else {
            Err(response
                .error
                .unwrap_or_else(|| failure(ComputerErrorCode::Internal, "helper failed")))
        }
    }

    fn set_stopped(&self, stopped: bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        // Nothing to stop in a helper that is not running; a fresh one starts
        // unlatched and the service refuses actions while stopped anyway.
        if inner.running.is_none() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let op = if stopped {
            HelperOp::Stop
        } else {
            HelperOp::ClearStop
        };
        let _ = Self::send(&mut inner, &HelperRequest { id, op });
    }

    fn set_session_paused(&self, session: &str, paused: bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.running.is_none() {
            return;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let op = HelperOp::SetSessionPaused {
            session: session.to_string(),
            paused,
        };
        let _ = Self::send(&mut inner, &HelperRequest { id, op });
    }

    fn status(&self) -> ComputerHelperStatus {
        self.inner.lock().map_or_else(
            |_| status(ComputerHelperState::Unavailable, None),
            |inner| inner.status.clone(),
        )
    }
}

#[cfg(test)]
/// Runs a backend in this process, for tests: the same `serve::run` dispatch
/// the helper uses, without a child process.
pub struct InProcessHelper {
    backend: Mutex<Box<dyn pragma_computer::ComputerBackend + Send>>,
    ctx: pragma_computer::Context,
}

#[cfg(test)]
impl InProcessHelper {
    /// Wraps `backend`, writing screenshots under `screenshots_dir`.
    pub fn new(
        backend: Box<dyn pragma_computer::ComputerBackend + Send>,
        screenshots_dir: PathBuf,
    ) -> Self {
        Self {
            backend: Mutex::new(backend),
            ctx: pragma_computer::Context {
                stop: pragma_computer::StopFlag::default(),
                screenshots_dir,
            },
        }
    }
}

#[cfg(test)]
impl Helper for InProcessHelper {
    fn call(&self, op: HelperOp, _timeout: Duration) -> ComputerResult<serde_json::Value> {
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| unavailable("backend lock poisoned"))?;
        pragma_computer::serve::run(backend.as_mut(), &self.ctx, op)
    }

    fn set_stopped(&self, stopped: bool) {
        if stopped {
            self.ctx.stop.trip();
        } else {
            self.ctx.stop.clear();
        }
    }

    fn set_session_paused(&self, session: &str, paused: bool) {
        self.ctx.stop.set_session_paused(session, paused);
    }

    fn status(&self) -> ComputerHelperStatus {
        status(ComputerHelperState::Ready, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied() -> ComputerPermissions {
        ComputerPermissions {
            platform: "macos".into(),
            supported: true,
            accessibility: ComputerPermissionState::Denied,
            screen_recording: ComputerPermissionState::Granted,
        }
    }

    #[test]
    fn denied_mac_permissions_are_refreshed_only_between_requests() {
        let op = HelperOp::Permissions(pragma_constants::ComputerPermissionsRequest::default());
        assert!(should_refresh_permissions(&op, Some(&denied()), true));
        assert!(!should_refresh_permissions(&op, Some(&denied()), false));
        assert!(!should_refresh_permissions(
            &HelperOp::Ping,
            Some(&denied()),
            true
        ));
        assert!(!should_refresh_permissions(&op, None, true));
    }

    #[test]
    fn granted_and_non_mac_permissions_keep_the_live_helper() {
        let op = HelperOp::Permissions(pragma_constants::ComputerPermissionsRequest::default());
        let mut permissions = denied();
        permissions.accessibility = ComputerPermissionState::Granted;
        assert!(!should_refresh_permissions(&op, Some(&permissions), true));
        permissions = denied();
        permissions.platform = "windows".into();
        assert!(!should_refresh_permissions(&op, Some(&permissions), true));
    }
}
