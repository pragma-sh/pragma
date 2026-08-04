//! End-to-end orchestration of one benchmark run.
//!
//! Order matters here. The TUI payload owns the terminal's mouse, so the two
//! payload-backed scenarios share one tab and one process; the scrollback
//! scenario needs a terminal with no mouse capture at all, so it gets its own.
//! Each tab is closed as soon as its scenarios finish, which keeps a slow
//! scenario from being measured against a screen that is also repainting
//! somebody else's 5000 lines.
//!
//! Around all of that sit the **load tabs**: `--tabs - 1` further terminals,
//! each running the TUI payload on a timer, opened before the first scenario and
//! left running until the last one finishes. A window with one terminal in it is
//! not the window anybody works in — a real workspace has agents streaming into
//! several tabs at once, and their PTY traffic, IPC events and xterm parsing are
//! paid on the same threads as the tab being measured. Only one tab is ever
//! driven; the rest exist to make the measurement happen under that load.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::driver::Driver;
use crate::error::{BenchError, BenchResult};
use crate::instance::{DevInstance, LaunchOptions};
use crate::report::Report;
use crate::scenarios::{self, Scenario, ScenarioOptions, ScenarioRun};

/// Terminal tabs open during a scenario, counting the measured one. Ten is a
/// plausible working set for one worktree: a handful of agents, a server, a
/// couple of shells.
pub const DEFAULT_TABS: usize = 10;

/// How often a load tab repaints. Roughly 20 frames a second each — busy enough
/// to keep the app's write, parse and event paths hot, slow enough that the
/// machine is running a workspace rather than a fork bomb.
pub const DEFAULT_LOAD_INTERVAL_MS: u64 = 50;

pub struct RunOptions {
    pub keystrokes: usize,
    pub scroll_ticks: usize,
    pub lines: usize,
    /// Terminal tabs open while a scenario runs, measured tab included.
    pub tabs: usize,
    /// Repaint interval of each background load tab.
    pub load_interval_ms: u64,
    pub gap_ms: u64,
    pub typing_gap_ms: u64,
    pub timeout_ms: u64,
    pub delta_y: f64,
    pub startup_timeout: Duration,
    pub out: PathBuf,
    pub keep_open: bool,
    pub only: Vec<String>,
}

impl RunOptions {
    /// Whether `scenario` was asked for. An empty `--only` means all of them.
    fn wants(&self, scenario: Scenario) -> bool {
        self.only.is_empty() || self.only.iter().any(|name| name == scenario.wire())
    }

    /// Background tabs to open: everything `--tabs` asked for except the one
    /// being measured. `--tabs 0` and `--tabs 1` both mean "no load".
    fn load_tabs(&self) -> usize {
        self.tabs.saturating_sub(1)
    }

    /// Per-scenario knobs. Typing and scrolling are paced separately because the
    /// loops differ: typing bursts (`--typing-gap-ms`, `0` by default, meaning
    /// as fast as the page can dispatch), scrolling waits for each notch to move
    /// the screen and then pauses for `--gap-ms`.
    fn scenario_options(&self, scenario: Scenario, count: usize) -> ScenarioOptions {
        ScenarioOptions {
            count,
            gap_ms: if scenario == Scenario::Typing {
                self.typing_gap_ms
            } else {
                self.gap_ms
            },
            timeout_ms: self.timeout_ms,
            delta_y: self.delta_y,
        }
    }
}

/// Launches a dev instance, runs the requested scenarios, and writes the report.
pub fn execute(options: &RunOptions) -> BenchResult<()> {
    reject_unknown_scenarios(&options.only)?;
    let repo_root = repo_root();
    let executable = std::env::current_exe()?;
    println!("benchmarking {}", repo_root.display());

    let instance = DevInstance::launch(&LaunchOptions {
        repo_root: repo_root.clone(),
        startup_timeout: options.startup_timeout,
        keep_open: options.keep_open,
        log: repo_root.join("bench-dev.log"),
    })?;
    let driver = instance.driver();
    scenarios::install(&driver)?;
    match instance.close_stale_payload_tabs() {
        Ok(0) => {}
        Ok(count) => println!("closed {count} payload tab(s) left by an earlier run"),
        Err(error) => println!("could not check for stale payload tabs ({error}); continuing"),
    }

    // Opened before anything is measured and closed only at the very end: the
    // load has to be there for every scenario, or the scenarios are not
    // comparable with each other.
    let mut load = LoadTabs::open(&instance, &executable, options)?;

    let mut runs = Vec::new();
    let tui_scenarios: Vec<Scenario> = [Scenario::Typing, Scenario::ScrollTui]
        .into_iter()
        .filter(|scenario| options.wants(*scenario))
        .collect();
    if !tui_scenarios.is_empty() {
        let command = payload_command(&executable, &["tui", "--lines"], options.lines);
        let mut payload = Payload::open(&instance, command)?;
        for scenario in tui_scenarios {
            let count = match scenario {
                Scenario::Typing => options.keystrokes,
                _ => options.scroll_ticks,
            };
            runs.push(measure(
                &driver,
                &mut load,
                &mut payload,
                scenario,
                &options.scenario_options(scenario, count),
            )?);
        }
        payload.close();
    }

    if options.wants(Scenario::ScrollBuffer) {
        let command = payload_command(&executable, &["lines", "--lines"], options.lines);
        let mut payload = Payload::open(&instance, command)?;
        runs.push(measure(
            &driver,
            &mut load,
            &mut payload,
            Scenario::ScrollBuffer,
            &options.scenario_options(Scenario::ScrollBuffer, options.scroll_ticks),
        )?);
        payload.close();
    }

    let report = Report::new(instance.channel.clone(), load.count() + 1, runs);
    drop(load);
    report.emit(&options.out)
}

/// The background tabs a run is measured next to.
///
/// They are opened first and dropped last, and every one of them runs the TUI
/// payload with `--auto-ms`, so it repaints on its own for the whole benchmark
/// without anybody driving it. Opening happens before the measured payload for
/// one reason beyond ordering: `tabOpened` makes the new tab the active one, so
/// whichever tab is opened last is the tab in front — which must be the one that
/// gets driven.
struct LoadTabs<'a> {
    instance: &'a DevInstance,
    command: String,
    wanted: usize,
    tabs: Vec<String>,
}

impl<'a> LoadTabs<'a> {
    fn open(
        instance: &'a DevInstance,
        executable: &Path,
        options: &RunOptions,
    ) -> BenchResult<Self> {
        let interval = options.load_interval_ms.to_string();
        let mut open = Self {
            instance,
            command: payload_command(
                executable,
                &["tui", "--auto-ms", &interval, "--lines"],
                options.lines,
            ),
            wanted: options.load_tabs(),
            tabs: Vec::new(),
        };
        open.fill()?;
        Ok(open)
    }

    /// Opens load tabs until `wanted` of them are painting.
    fn fill(&mut self) -> BenchResult<()> {
        if self.wanted == 0 {
            return Ok(());
        }
        println!("opening {} background load tab(s)…", self.wanted);
        let driver = self.instance.driver();
        for index in 0..self.wanted {
            let tab = self.instance.open_payload(&self.command)?;
            // Waited for one at a time, and all of them before the payload tab
            // is opened at all: a PTY spawning and a shell starting are one-off
            // costs, and a scenario that began while nine of them were still
            // landing would measure the start-up, not the load.
            scenarios::wait_painted(&driver, &tab).map_err(|error| {
                BenchError::Setup(format!(
                    "load tab {} of {} never painted: {error}",
                    index + 1,
                    self.wanted
                ))
            })?;
            self.tabs.push(tab);
        }
        Ok(())
    }

    /// Replaces every load tab after the app was restarted underneath the run.
    ///
    /// A fresh document mounts only the *active* tab, so the surviving load tabs
    /// are still running their payloads but no longer attached to a terminal:
    /// their output goes nowhere and the window they were meant to load is idle.
    /// Reopening is what puts them back in front of the app one by one — and it
    /// must happen before the payload tab is reopened, so the payload is the tab
    /// left in front.
    fn reopen(&mut self) -> BenchResult<()> {
        self.close();
        self.fill()
    }

    fn count(&self) -> usize {
        self.tabs.len()
    }

    fn close(&mut self) {
        for tab in self.tabs.drain(..) {
            self.instance.close_tab(&tab);
        }
    }
}

impl Drop for LoadTabs<'_> {
    fn drop(&mut self) {
        self.close();
    }
}

/// A payload process in a terminal tab, reopenable after the app restarts.
struct Payload<'a> {
    instance: &'a DevInstance,
    command: String,
    tab: String,
}

impl<'a> Payload<'a> {
    fn open(instance: &'a DevInstance, command: String) -> BenchResult<Self> {
        let tab = instance.open_payload(&command)?;
        Ok(Self {
            instance,
            command,
            tab,
        })
    }

    /// Replaces the tab with a fresh one running the same payload.
    fn reopen(&mut self) -> BenchResult<()> {
        self.instance.close_tab(&self.tab);
        self.tab = self.instance.open_payload(&self.command)?;
        Ok(())
    }

    fn close(self) {
        self.instance.close_tab(&self.tab);
    }
}

/// Runs one scenario, recovering once from the app being restarted underneath it.
///
/// Tauri's dev watcher replaces the app when a watched source file changes, and
/// `bun run dev` touches one on its way up. That takes the injected runner (a new
/// document) and every tab's mount with it, so recovery is: adopt the new app,
/// re-inject, reopen the load tabs, reopen the payload, measure again. Only a
/// second failure is fatal — a benchmark that died on a routine restart would be
/// unusable.
fn measure(
    driver: &Driver,
    load: &mut LoadTabs<'_>,
    payload: &mut Payload<'_>,
    scenario: Scenario,
    options: &ScenarioOptions,
) -> BenchResult<ScenarioRun> {
    println!("running {scenario} ({} inputs)…", options.count);
    // Raised before every scenario, not just once: anything that steals focus
    // between scenarios (a notification, another window) would otherwise stop
    // the window being painted for the rest of the run.
    if !payload.instance.focus(driver)? {
        println!("  warning: the dev window is not focused — leave it in front, or samples will time out");
    }
    let run = match scenarios::run(driver, &payload.tab, scenario, options) {
        Ok(run) => run,
        Err(first) => {
            println!("\n  {scenario} could not complete ({first}); recovering and retrying once");
            driver.relocate();
            scenarios::install(driver)?;
            // Load first, payload last: opening a tab makes it the active one,
            // and the measured tab has to be the one left in front.
            load.reopen()?;
            payload.reopen()?;
            scenarios::run(driver, &payload.tab, scenario, options)?
        }
    };
    println!(
        "\r  {scenario}: {} measured, {} dropped, p95 {}ms",
        run.summary.count, run.summary.dropped, run.summary.p95_ms
    );
    Ok(run)
}

/// The command line a payload tab runs.
///
/// The executable is quoted because it is handed to a shell, and a developer's
/// checkout can easily sit under a path with a space in it.
fn payload_command(executable: &Path, args: &[&str], lines: usize) -> String {
    format!(
        "'{}' {} {lines}",
        executable.display().to_string().replace('\'', "'\\''"),
        args.join(" ")
    )
}

/// The worktree this binary was compiled in — the same root the dev build
/// derives its channel from, which is what makes the instance findable.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn reject_unknown_scenarios(only: &[String]) -> BenchResult<()> {
    let known = [
        Scenario::Typing,
        Scenario::ScrollTui,
        Scenario::ScrollBuffer,
    ];
    for name in only {
        if !known.iter().any(|scenario| scenario.wire() == name) {
            return Err(BenchError::Setup(format!(
                "unknown scenario `{name}`; expected one of {}",
                known
                    .iter()
                    .map(|scenario| scenario.wire())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(only: &[&str]) -> RunOptions {
        RunOptions {
            keystrokes: 1,
            scroll_ticks: 1,
            lines: 10,
            tabs: DEFAULT_TABS,
            load_interval_ms: DEFAULT_LOAD_INTERVAL_MS,
            gap_ms: 0,
            typing_gap_ms: 0,
            timeout_ms: 10,
            delta_y: 120.0,
            startup_timeout: Duration::from_secs(1),
            out: PathBuf::from("report.json"),
            keep_open: false,
            only: only.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    #[test]
    fn an_empty_filter_selects_everything() {
        let options = options(&[]);
        assert!(options.wants(Scenario::Typing));
        assert!(options.wants(Scenario::ScrollTui));
        assert!(options.wants(Scenario::ScrollBuffer));
    }

    #[test]
    fn typing_and_scrolling_are_paced_from_different_knobs() {
        let mut options = options(&[]);
        options.gap_ms = 16;
        options.typing_gap_ms = 0;
        assert_eq!(options.scenario_options(Scenario::Typing, 1).gap_ms, 0);
        assert_eq!(options.scenario_options(Scenario::ScrollTui, 1).gap_ms, 16);
        assert_eq!(
            options.scenario_options(Scenario::ScrollBuffer, 1).gap_ms,
            16
        );
    }

    #[test]
    fn every_tab_but_the_measured_one_carries_load() {
        let mut options = options(&[]);
        assert_eq!(options.load_tabs(), DEFAULT_TABS - 1);
        options.tabs = 1;
        assert_eq!(options.load_tabs(), 0, "one tab is the measured one");
        // `--tabs 0` is nonsense rather than an error: it still leaves the one
        // tab a scenario cannot run without, and no load beside it.
        options.tabs = 0;
        assert_eq!(options.load_tabs(), 0);
    }

    #[test]
    fn the_load_payload_is_the_tui_driving_itself() {
        let options = options(&[]);
        let interval = options.load_interval_ms.to_string();
        let command = payload_command(
            Path::new("/tmp/pragma-bench"),
            &["tui", "--auto-ms", &interval, "--lines"],
            options.lines,
        );
        assert_eq!(command, "'/tmp/pragma-bench' tui --auto-ms 50 --lines 10");
    }

    #[test]
    fn a_filter_selects_only_what_it_names() {
        let options = options(&["typing"]);
        assert!(options.wants(Scenario::Typing));
        assert!(!options.wants(Scenario::ScrollTui));
    }

    #[test]
    fn unknown_scenario_names_fail_before_anything_is_launched() {
        assert!(reject_unknown_scenarios(&["typing".to_string()]).is_ok());
        assert!(reject_unknown_scenarios(&["scrol-tui".to_string()]).is_err());
    }

    #[test]
    fn payload_paths_survive_spaces_and_quotes() {
        let command = payload_command(
            Path::new("/Users/a b/pragma-bench"),
            &["tui", "--lines"],
            5000,
        );
        assert_eq!(command, "'/Users/a b/pragma-bench' tui --lines 5000");
        let quoted = payload_command(
            Path::new("/tmp/o'brien/pragma-bench"),
            &["lines", "--lines"],
            10,
        );
        assert_eq!(quoted, "'/tmp/o'\\''brien/pragma-bench' lines --lines 10");
    }

    #[test]
    fn the_repo_root_is_the_workspace_that_holds_this_crate() {
        let root = repo_root();
        assert!(root
            .join("packages")
            .join("bench")
            .join("Cargo.toml")
            .exists());
    }
}
