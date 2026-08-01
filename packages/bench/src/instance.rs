//! Lifecycle of the Pragma dev instance a run measures.
//!
//! The benchmark launches its own `bun run dev` rather than attaching to
//! whatever happens to be open. A dev build is scoped to the worktree it was
//! compiled in — channel, data directory, and server socket all derive from it —
//! so "the instance for this worktree" is a value the benchmark can compute
//! instead of a window it has to guess at. Everything this module resolves is
//! derived from that one fact.

use std::fs;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use pragma_client::{executable_name, LocalServerConfig, PragmaClient};
use pragma_constants::{WorkspaceSnapshot, CONSTANTS};
use serde_json::{json, Value};

use crate::bridge::{self, BridgeToken};
use crate::driver::Driver;
use crate::error::{BenchError, BenchResult};

/// How often every "wait for X" loop re-checks.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// How often progress is printed while waiting for a build.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(15);

/// Ceiling on the pre-flight connect that tests whether Vite's port is taken.
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

/// Pause after asking the window to reload, before probing whether it is back.
const RELOAD_SETTLE: Duration = Duration::from_secs(2);

/// Ceiling on a window reload, which re-runs the frontend's whole boot.
const RELOAD_TIMEOUT: Duration = Duration::from_mins(1);

/// Ceiling on a newly added project reaching the published workspace snapshot.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// Pause after raising the window, before asking the page whether it has focus.
const FOCUS_SETTLE: Duration = Duration::from_millis(750);

pub struct LaunchOptions {
    /// Repository root — the worktree whose dev build is measured.
    pub repo_root: PathBuf,
    /// Ceiling on the whole start-up, which includes a possible cargo build.
    pub startup_timeout: Duration,
    /// Leave the dev instance running after the run, for inspection.
    pub keep_open: bool,
    /// Where the dev instance's own output is written.
    pub log: PathBuf,
}

/// A launched dev instance plus everything needed to talk to it.
pub struct DevInstance {
    child: Child,
    /// Pid of the Tauri app itself (not of `bun`), which is what `--pid` selects.
    /// Shared with every [`Driver`] so a restart re-points all of them at once.
    app_pid: Arc<AtomicU32>,
    /// Bridges that predate this run and must never be adopted.
    foreign: Arc<Vec<u32>>,
    pub channel: String,
    pub socket: PathBuf,
    /// Worktree the benchmark's tabs are opened in.
    worktree: String,
    /// This instance's own `pragma-cli`, installed beside its data directory.
    cli: PathBuf,
    log: PathBuf,
    keep_open: bool,
}

impl DevInstance {
    /// Starts a dev build and waits until it is drivable: bridge listening,
    /// server socket bound, and this worktree known to the app.
    pub fn launch(options: &LaunchOptions) -> BenchResult<Self> {
        if cfg!(windows) {
            return Err(BenchError::Setup(
                "the Tauri dev bridge writes its token to /tmp, so the benchmark does not run on \
                 Windows yet"
                    .to_string(),
            ));
        }
        Driver::check_available()?;
        check_dev_port_free(&options.repo_root)?;

        let channel = pragma_protocol::dev_channel(&options.repo_root);
        let app_data_dir = app_data_dir()?;
        let socket = PragmaClient::new_local(LocalServerConfig::new(
            app_data_dir.clone(),
            channel.clone(),
            options.repo_root.clone(),
            true,
            None,
        ))
        .socket_path();

        // Ignore bridges that were already listening: after the spawn, the new
        // instance is exactly the one whose token file is not in this set and
        // whose pid descends from the process just started.
        let foreign = Arc::new(
            bridge::tokens()?
                .into_iter()
                .map(|token| token.pid)
                .collect::<Vec<_>>(),
        );

        let log_file = fs::File::create(&options.log)?;
        let child = pragma_platform::process::command("bun")
            .args(["run", "dev"])
            .current_dir(&options.repo_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file.try_clone()?))
            .stderr(Stdio::from(log_file))
            .spawn()
            .map_err(|error| BenchError::Setup(format!("could not run `bun run dev`: {error}")))?;

        let cli = pragma_client::instance_data_dir(&app_data_dir, &channel)
            .join("bin")
            .join(executable_name("pragma-cli"));

        let mut instance = Self {
            child,
            app_pid: Arc::new(AtomicU32::new(0)),
            foreign,
            channel,
            socket,
            worktree: String::new(),
            cli,
            log: options.log.clone(),
            keep_open: options.keep_open,
        };

        let token = instance.wait_for_bridge(options.startup_timeout)?;
        instance.app_pid.store(token.pid, Ordering::SeqCst);
        instance.wait_for_socket(options.startup_timeout)?;

        let driver = instance.driver();
        instance.worktree = instance.resolve_worktree(&driver, &options.repo_root)?;
        Ok(instance)
    }

    /// A handle for driving this instance. Every handle shares one pid cell, so
    /// when any of them re-resolves a restarted app the rest follow.
    #[must_use]
    pub fn driver(&self) -> Driver {
        Driver::new(
            Arc::clone(&self.app_pid),
            self.child.id(),
            Arc::clone(&self.foreign),
        )
    }

    /// Blocks until a bridge token appears for a process descended from the
    /// spawned `bun`, so a second dev build on the machine is never adopted.
    fn wait_for_bridge(&mut self, timeout: Duration) -> BenchResult<BridgeToken> {
        println!("waiting for the dev build (first run compiles the app)…");
        let started = Instant::now();
        let mut last_progress = Instant::now();
        while started.elapsed() < timeout {
            self.check_alive()?;
            if let Some(token) = bridge::locate(self.child.id(), &self.foreign) {
                println!("dev instance ready after {:?}", started.elapsed());
                return Ok(token);
            }
            if last_progress.elapsed() >= PROGRESS_INTERVAL {
                println!(
                    "  … still building/starting ({:?} elapsed)",
                    started.elapsed()
                );
                last_progress = Instant::now();
            }
            thread::sleep(POLL_INTERVAL);
        }
        Err(BenchError::Timeout {
            what: "the dev instance's Tauri bridge".to_string(),
            waited: started.elapsed(),
        })
    }

    /// The app starts its server asynchronously, so the socket can trail the
    /// bridge by a few seconds on a cold start.
    fn wait_for_socket(&mut self, timeout: Duration) -> BenchResult<()> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            self.check_alive()?;
            if self.socket.exists() {
                return Ok(());
            }
            thread::sleep(POLL_INTERVAL);
        }
        Err(BenchError::Timeout {
            what: format!("the server socket at {}", self.socket.display()),
            waited: started.elapsed(),
        })
    }

    /// Finds the worktree row for this repository, adding the project to the dev
    /// instance first if this is its very first run against this worktree, and
    /// leaves the window displaying it.
    fn resolve_worktree(&mut self, driver: &Driver, repo_root: &Path) -> BenchResult<String> {
        let worktree = if let Some(id) = self.worktree_id(repo_root)? {
            id
        } else {
            println!("registering {} with the dev instance…", repo_root.display());
            driver.invoke(
                "add_project",
                &json!({ "path": repo_root.to_string_lossy() }),
            )?;
            self.await_worktree(repo_root)?
        };
        self.show_worktree(driver, &worktree)?;
        Ok(worktree)
    }

    /// Waits for a just-added project to reach the published workspace snapshot.
    fn await_worktree(&self, repo_root: &Path) -> BenchResult<String> {
        let started = Instant::now();
        while started.elapsed() < SNAPSHOT_TIMEOUT {
            if let Some(id) = self.worktree_id(repo_root)? {
                return Ok(id);
            }
            thread::sleep(POLL_INTERVAL);
        }
        Err(BenchError::Timeout {
            what: "the project to appear in the workspace snapshot".to_string(),
            waited: started.elapsed(),
        })
    }

    /// Makes the window display `worktree`, so tabs opened in it actually mount.
    ///
    /// Necessary because opening a tab does not bring its project to the front:
    /// the app's `tabOpened` handler records the worktree *within* its project
    /// and sets it active there, but never switches the displayed project. A
    /// window left on another project therefore renders no `TerminalView` for
    /// the new tab, and a terminal that is not rendered does not exist to
    /// measure — the benchmark would wait out its timeout against a tab that was
    /// opened perfectly well.
    ///
    /// Selection is persisted through `set_active_selection` and re-hydrated on
    /// boot, so writing it and reloading is what actually moves the window.
    fn show_worktree(&self, driver: &Driver, worktree: &str) -> BenchResult<()> {
        let Some(project) = self.project_of(worktree)? else {
            return Err(BenchError::Setup(format!(
                "worktree {worktree} has no project in the workspace snapshot"
            )));
        };
        let selection = json!({
            "projectId": project,
            "worktreeByProject": { project.clone(): worktree },
        })
        .to_string();
        driver.invoke("set_active_selection", &json!({ "value": selection }))?;
        reload_window(driver)
    }

    /// Project owning `worktree`, per the published snapshot.
    fn project_of(&self, worktree: &str) -> BenchResult<Option<String>> {
        let path = self.server_dir().join("workspace.json");
        let Ok(contents) = fs::read_to_string(&path) else {
            return Ok(None);
        };
        let snapshot: WorkspaceSnapshot = serde_json::from_str(&contents)?;
        Ok(snapshot
            .worktrees
            .iter()
            .find(|candidate| candidate.id == worktree)
            .map(|candidate| candidate.project_id.clone()))
    }

    /// Deepest worktree in the published snapshot that contains `repo_root`.
    fn worktree_id(&self, repo_root: &Path) -> BenchResult<Option<String>> {
        let path = self.server_dir().join("workspace.json");
        let snapshot = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let snapshot: WorkspaceSnapshot = serde_json::from_str(&snapshot)?;
        let root = pragma_platform::path::canonicalize(repo_root)
            .unwrap_or_else(|_| repo_root.to_path_buf());
        let best = snapshot
            .worktrees
            .iter()
            .filter(|worktree| {
                let candidate = pragma_platform::path::canonicalize(Path::new(&worktree.path))
                    .unwrap_or_else(|_| PathBuf::from(&worktree.path));
                root.starts_with(&candidate)
            })
            .max_by_key(|worktree| worktree.path.len());
        Ok(best.map(|worktree| worktree.id.clone()))
    }

    /// Opens `payload` in a real terminal tab, through the same CLI a plugin or
    /// a developer would use, and returns the new tab's id.
    pub fn open_payload(&self, payload: &str) -> BenchResult<String> {
        if !self.cli.exists() {
            return Err(BenchError::Setup(format!(
                "the dev instance has not installed its CLI at {}",
                self.cli.display()
            )));
        }
        let value = self.cli_json(&[
            "tab",
            "open",
            "--worktree",
            &self.worktree,
            "--kind",
            "terminal",
            "--title",
            CONSTANTS.bench.tab_title.as_str(),
            "--command",
            payload,
        ])?;
        value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| BenchError::Setup("tab open returned no tab id".to_string()))
    }

    /// Closes a tab the benchmark opened. Best-effort: teardown must not turn a
    /// finished run into a failed one.
    pub fn close_tab(&self, tab_id: &str) {
        let _ = self.cli_json(&["tab", "close", tab_id]);
    }

    /// Raises the window so the compositor keeps painting it, and says whether
    /// the page ended up focused.
    pub fn focus(&self, driver: &Driver) -> BenchResult<bool> {
        focus_window(driver, self.app_pid.load(Ordering::SeqCst))
    }

    /// Closes payload tabs left behind by an earlier run that did not finish.
    ///
    /// They are identified by the title the benchmark gives its own tabs, so
    /// nothing of the user's is ever touched. Worth doing: a stale payload is
    /// still a live process redrawing 5000 lines next to the one being measured.
    pub fn close_stale_payload_tabs(&self) -> BenchResult<usize> {
        let title = CONSTANTS.bench.tab_title.as_str();
        let tabs = self.cli_json(&["tab", "list", "--worktree", &self.worktree])?;
        let stale: Vec<String> = tabs
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|tab| tab.get("title").and_then(Value::as_str) == Some(title))
                    .filter_map(|tab| tab.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for tab in &stale {
            self.close_tab(tab);
        }
        Ok(stale.len())
    }

    fn cli_json(&self, args: &[&str]) -> BenchResult<serde_json::Value> {
        let output = pragma_platform::process::command(&self.cli)
            .arg("--json")
            .args(args)
            .env("PRAGMA_SERVER_SOCKET", &self.socket)
            .env("PRAGMA_DAEMON_SOCKET", &self.socket)
            .output()?;
        if !output.status.success() {
            return Err(BenchError::Command {
                command: format!("pragma-cli {}", args.join(" ")),
                status: output.status.to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    fn server_dir(&self) -> PathBuf {
        self.socket
            .parent()
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
    }

    /// Turns "the app died during start-up" into an error naming its log, rather
    /// than a timeout that says nothing about why.
    fn check_alive(&mut self) -> BenchResult<()> {
        match self.child.try_wait()? {
            Some(_) => Err(BenchError::DevExited {
                log: self.log.clone(),
            }),
            None => Ok(()),
        }
    }
}

impl Drop for DevInstance {
    fn drop(&mut self) {
        if self.keep_open {
            println!(
                "dev instance left running (pid {}); its log is {}",
                self.app_pid.load(Ordering::SeqCst),
                self.log.display()
            );
            return;
        }
        // The whole tree, read from the process table before anything is killed.
        //
        // `kill_tree` reaches one generation on Unix (`pkill -P`), and this tree
        // is four deep: `bun run dev` → `bash -c` → `tauri dev` → the app, with
        // Vite alongside. Killing the supervisor reparents the rest to init,
        // where they keep holding Vite's port — and the next run then refuses to
        // start with "port 1420 is already in use", blaming a dev server the
        // previous run was supposed to have taken with it.
        //
        // Leaves first, root last: `kill` prints "No such process" for a pid
        // that is already gone, so killing the supervisor first would fill the
        // run's own output with noise about the children it just orphaned.
        for pid in descendants(self.child.id()).into_iter().rev() {
            // A false here is a process that had already exited, which is the
            // outcome this loop wants anyway.
            let _ = pragma_platform::process::kill(pid);
        }
        let _ = pragma_platform::process::kill_tree(self.child.id());
        let _ = self.child.wait();
    }
}

/// Every process descending from `root`, parents before children.
///
/// Reads the live process table once, so it must be called while the tree is
/// still intact — killing the root first orphans its children onto init and the
/// links are gone.
fn descendants(root: u32) -> Vec<u32> {
    let Ok(processes) = pragma_platform::process::list_processes() else {
        return Vec::new();
    };
    descendants_of(&processes, root)
}

/// The tree walk, over a table rather than the host, so it can be tested.
fn descendants_of(
    processes: &std::collections::HashMap<u32, pragma_platform::process::ProcessEntry>,
    root: u32,
) -> Vec<u32> {
    let mut found = Vec::new();
    let mut frontier = vec![root];
    // Bounded by the table's size: every pid is enqueued at most once, because
    // a process has exactly one parent and `root` itself is never re-added.
    while let Some(parent) = frontier.pop() {
        for (pid, entry) in processes {
            if entry.parent_pid == parent && *pid != root && !found.contains(pid) {
                found.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    found
}

/// Brings the app's window to the front, and reports whether the page agrees.
///
/// This is a correctness requirement, not a nicety. xterm paints from
/// `requestAnimationFrame`, and both macOS and Linux compositors stop delivering
/// frames to an occluded window — the terminal still consumes input and its
/// buffer still advances, but nothing is ever rendered, so every sample times
/// out. A benchmark run behind another window measures the compositor's
/// throttling policy, not the terminal.
///
/// Raising is best-effort per platform; the returned flag is what the page
/// actually reports, so the caller can warn on the case that matters.
fn focus_window(driver: &Driver, pid: u32) -> BenchResult<bool> {
    raise_window(pid);
    thread::sleep(FOCUS_SETTLE);
    let focused = driver.eval("String(document.hasFocus())")?;
    Ok(focused.as_str() == Some("true"))
}

/// Platform-specific window raise. Failures are ignored: the caller checks the
/// result that matters (whether the page has focus) rather than this one.
fn raise_window(pid: u32) {
    if cfg!(target_os = "macos") {
        let script = format!(
            "tell application \"System Events\" to set frontmost of \
             (first application process whose unix id is {pid}) to true"
        );
        let _ = pragma_platform::process::command("osascript")
            .args(["-e", &script])
            .output();
    } else {
        // X11 only; a Wayland session has no equivalent, which is why the page's
        // own answer is what the caller trusts.
        let _ = pragma_platform::process::command("xdotool")
            .args(["search", "--pid", &pid.to_string(), "windowactivate"])
            .output();
    }
}

/// Reloads the app window and waits for the document to finish loading.
///
/// The reload itself is deferred to a timer so the `eval` can return before the
/// page goes away: a navigation mid-eval never delivers the bridge's result
/// callback, and the call would fail with the bridge's five-second timeout.
fn reload_window(driver: &Driver) -> BenchResult<()> {
    println!("reloading the dev window onto the worktree under test…");
    driver.eval("(setTimeout(() => location.reload(), 0), \"reloading\")")?;
    let started = Instant::now();
    // Give the navigation time to actually begin; an immediate probe would read
    // the *old* document as complete and return before anything reloaded.
    thread::sleep(RELOAD_SETTLE);
    while started.elapsed() < RELOAD_TIMEOUT {
        if let Ok(state) = driver.eval("document.readyState") {
            if state.as_str() == Some("complete") {
                return Ok(());
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(BenchError::Timeout {
        what: "the dev window to finish reloading".to_string(),
        waited: started.elapsed(),
    })
}

/// Fails fast when another dev server already holds Vite's port.
///
/// Two `bun run dev` instances cannot coexist: `devUrl` pins a single port, so
/// the second one's Vite exits and Tauri kills the build with
/// `The "beforeDevCommand" terminated with a non-zero status code`. Without this
/// check that shows up as a five-minute wait followed by "the dev instance
/// exited", which names neither the cause nor the fix.
fn check_dev_port_free(repo_root: &Path) -> BenchResult<()> {
    let Some(port) = dev_url_port(repo_root) else {
        return Ok(());
    };
    if port_is_served(port) {
        return Err(BenchError::Setup(format!(
            "port {port} is already in use, so a second dev server cannot start — \
             quit the running `bun run dev` (or the dev app) and try again"
        )));
    }
    Ok(())
}

/// Whether something answers on `port`, on either IP stack.
///
/// Connecting rather than binding, and on both loopback addresses: Vite listens
/// on `localhost`, which macOS resolves to `::1` first, so a bind test against
/// `127.0.0.1` alone happily succeeds while the port is very much taken.
fn port_is_served(port: u16) -> bool {
    const LOOPBACKS: [IpAddr; 2] = [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ];
    LOOPBACKS.iter().any(|address| {
        TcpStream::connect_timeout(&SocketAddr::new(*address, port), PORT_PROBE_TIMEOUT).is_ok()
    })
}

/// The port `tauri.conf.json` expects Vite on. Read rather than hard-coded, so
/// the benchmark cannot disagree with the config the build actually uses.
fn dev_url_port(repo_root: &Path) -> Option<u16> {
    let config = repo_root
        .join("apps")
        .join("pragma")
        .join("src-tauri")
        .join("tauri.conf.json");
    let contents = fs::read_to_string(config).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let url = value.pointer("/build/devUrl")?.as_str()?;
    url.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

/// The OS directory Tauri resolves `appDataDir` to for this app.
///
/// Resolved by `tauri-agent-tools`, which implements Tauri's own path rules, so
/// the benchmark does not keep a second copy of them.
fn app_data_dir() -> BenchResult<PathBuf> {
    let identifier = CONSTANTS.app.identifier.as_str();
    let output = pragma_platform::process::command("tauri-agent-tools")
        .args(["app-paths", "--identifier", identifier, "--json"])
        .output()
        .map_err(|_| BenchError::ToolMissing)?;
    if !output.status.success() {
        return Err(BenchError::Command {
            command: "tauri-agent-tools app-paths".to_string(),
            status: output.status.to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let platform = value
        .get("platform")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    value
        .pointer(&format!("/paths/{platform}/appDataDir"))
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
            BenchError::Setup(format!(
                "tauri-agent-tools app-paths reported no appDataDir for {platform}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `bun run dev` → `bash -c` → `tauri dev` → the app, with Vite alongside:
    /// the shape that survived teardown and held the port.
    fn dev_tree() -> std::collections::HashMap<u32, pragma_platform::process::ProcessEntry> {
        let entry = |parent_pid: u32, name: &str| pragma_platform::process::ProcessEntry {
            parent_pid,
            name: name.to_string(),
        };
        [
            (10, entry(1, "bun")),
            (20, entry(10, "bash")),
            (30, entry(20, "tauri")),
            (40, entry(30, "pragma")),
            (50, entry(20, "vite")),
            (60, entry(1, "someone-elses-editor")),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn teardown_collects_every_generation_not_just_the_children() {
        let mut found = descendants_of(&dev_tree(), 10);
        found.sort_unstable();
        assert_eq!(found, vec![20, 30, 40, 50]);
    }

    #[test]
    fn teardown_never_reaches_outside_the_instance_it_launched() {
        assert!(descendants_of(&dev_tree(), 10).iter().all(|pid| *pid != 60));
        assert!(descendants_of(&dev_tree(), 40).is_empty());
    }

    #[test]
    fn a_process_is_killed_after_its_own_children() {
        let found = descendants_of(&dev_tree(), 10);
        let position = |pid: u32| found.iter().position(|found| *found == pid);
        // The order Drop reverses, so `tauri dev` must appear before the app.
        assert!(position(30) < position(40), "got {found:?}");
        assert!(position(20) < position(30), "got {found:?}");
    }

    #[test]
    fn the_dev_port_comes_from_the_tauri_config() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("the crate sits two levels below the repo root");
        assert!(
            dev_url_port(root).is_some(),
            "tauri.conf.json should still declare build.devUrl with a port"
        );
        assert_eq!(dev_url_port(Path::new("/nonexistent")), None);
    }
}
