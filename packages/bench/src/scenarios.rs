//! The three things a run measures, and how each is driven.
//!
//! Every scenario follows the same shape: install the runner in the page, wait
//! until the payload has painted, start the loop, then poll it to completion.
//! The loop itself runs in the webview — see `runner.js` for why.

use std::fmt;
use std::io::Write as _;
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::CONSTANTS;
use serde_json::{json, Value};

use crate::driver::Driver;
use crate::error::{BenchError, BenchResult};
use crate::stats::Summary;

/// The injected runner, with its two shared globals substituted in from
/// `@pragma/constants` so the page and this crate cannot drift apart.
const RUNNER_JS: &str = include_str!("runner.js");
const CONFIG_PLACEHOLDER: &str = "__PRAGMA_BENCH_CONFIG__";

/// Characters the typing scenario cycles through.
///
/// Letters only, and deliberately no spaces. Two independent reasons:
///
/// - Every character here is a printable key that reaches the payload as
///   itself, so a sample can never be a keybinding the app swallowed instead.
/// - A **space cannot be delivered by a synthetic `keydown` at all.** xterm's
///   `evaluateKeyboardEvent` only takes the printable path for `keyCode >= 48`;
///   space is 32, and a real one arrives through the hidden textarea's
///   `keypress`/`input` event, which the browser generates only for genuine key
///   input. The corpus used to be "the quick brown fox …", so 9 characters in 44
///   were guaranteed drops — a flat 20% of every typing run, reported as lag.
const TYPING_TEXT: &str = "thequickbrownfoxjumpsoverthelazydog";

/// How often a running scenario is polled from the outside. Well under the
/// bridge's five-second eval ceiling, and rare enough that the polling itself
/// is not part of what the scenario measures.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Consecutive failed progress reads before a scenario is abandoned. Each failed
/// read costs the CLI's own timeout, so this is minutes of unreachability, not
/// seconds — enough to ride out the window being busy, short of hanging on an
/// app that has genuinely gone.
const MAX_POLL_FAILURES: u32 = 8;

/// Attempts at injecting the runner before giving up.
const INSTALL_ATTEMPTS: u32 = 4;

/// Ceiling on how long the payload may take to paint its first frame. Covers the
/// app mounting the tab, the server spawning a PTY, a shell starting, and the
/// payload's own first draw.
const READY_TIMEOUT: Duration = Duration::from_mins(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// Keystrokes into the ratatui payload.
    Typing,
    /// Wheel notches into the ratatui payload, which owns the scroll itself.
    ScrollTui,
    /// Wheel notches over a plain 5000-line dump, scrolled by xterm alone.
    ScrollBuffer,
}

impl Scenario {
    /// Wire name, matching the `scenario` values `runner.js` branches on.
    #[must_use]
    pub fn wire(self) -> &'static str {
        match self {
            Self::Typing => "typing",
            Self::ScrollTui => "scroll-tui",
            Self::ScrollBuffer => "scroll-buffer",
        }
    }

    /// One line explaining what a reader is looking at in the report.
    #[must_use]
    pub fn description(self) -> &'static str {
        match self {
            Self::Typing => "keydown → PTY → TUI redraw → xterm paint",
            Self::ScrollTui => "wheel → mouse report → TUI redraw → xterm paint",
            Self::ScrollBuffer => "wheel → xterm scrollback → xterm paint",
        }
    }

    /// Whether the scenario reads the TUI payload's status row.
    fn uses_payload_status(self) -> bool {
        self != Self::ScrollBuffer
    }

    /// Whether xterm must (or must not) be in mouse-tracking mode for this
    /// scenario to be the thing it claims to measure. `None` means it does not
    /// matter — typing goes to the PTY either way.
    ///
    /// This is the entire difference between the two scroll scenarios, and it is
    /// invisible in the samples. With tracking on, a wheel notch becomes a mouse
    /// report the payload answers with a redraw; with it off, xterm scrolls its
    /// own scrollback and the payload never hears about it. A `scroll-tui` run
    /// against a terminal that never entered mouse tracking is not a slow TUI —
    /// it is `scroll-buffer` under the wrong name.
    fn expects_mouse_capture(self) -> Option<bool> {
        match self {
            Self::Typing => None,
            Self::ScrollTui => Some(true),
            Self::ScrollBuffer => Some(false),
        }
    }
}

impl fmt::Display for Scenario {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.wire())
    }
}

/// Knobs shared by every scenario.
pub struct ScenarioOptions {
    pub count: usize,
    /// Pacing between inputs. The two loops read it differently, because the
    /// two input kinds behave differently: typing sends a burst and this is the
    /// delay between consecutive keystrokes (`0` = the shortest turn of the
    /// event loop that still lets the renderer paint), while scrolling waits for
    /// each notch to move the screen and this is the pause after it did.
    pub gap_ms: u64,
    /// How long one input may take to reach the screen before it is a drop.
    pub timeout_ms: u64,
    /// Wheel distance per notch, in pixels, as a trackpad reports it.
    pub delta_y: f64,
}

/// One scenario's outcome.
pub struct ScenarioRun {
    pub scenario: Scenario,
    pub samples: Vec<f64>,
    pub summary: Summary,
    pub sent: usize,
    /// Whether the window lost focus at any point. Recorded because an occluded
    /// window is not painted, which turns every sample into a timeout — numbers
    /// from such a run describe the compositor, not the terminal.
    pub unfocused: bool,
}

/// Installs the runner into the page. Idempotent — re-running a benchmark
/// against a hot-reloaded window just replaces it.
pub fn install(driver: &Driver) -> BenchResult<()> {
    let config = json!({
        "runnerGlobal": CONSTANTS.bench.runner_global,
        "hookGlobal": CONSTANTS.bench.hook_global,
    });
    let source = RUNNER_JS.replace(CONFIG_PLACEHOLDER, &config.to_string());
    let path = std::env::temp_dir().join(format!("pragma-bench-runner-{}.js", std::process::id()));
    std::fs::write(&path, source)?;
    // Retried because installing happens at the two moments the window is least
    // responsive — just after boot, and just after a restart during recovery —
    // and the CLI gives up on a slow window before the window has actually failed.
    let mut result = driver.eval_file(&path);
    for _ in 1..INSTALL_ATTEMPTS {
        if result.is_ok() {
            break;
        }
        thread::sleep(POLL_INTERVAL);
        result = driver.eval_file(&path);
    }
    let _ = std::fs::remove_file(&path);
    result?;
    Ok(())
}

/// Closes any modal that is up, and fails if one refuses to go.
///
/// Called before every scenario because a dialog silently invalidates a whole
/// run: input still reaches the terminal behind it, but xterm stops painting, so
/// every sample times out. Better to refuse with the dialog's own text than to
/// report a 100%-dropped scenario as if it were a measurement.
pub fn clear_modals(driver: &Driver) -> BenchResult<()> {
    let state = driver.eval(&format!(
        "{}.dismissModals()",
        CONSTANTS.bench.runner_global
    ))?;
    let remaining = state
        .get("remaining")
        .and_then(Value::as_array)
        .map(|dialogs| {
            dialogs
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .unwrap_or_default();
    if remaining.is_empty() {
        return Ok(());
    }
    Err(BenchError::Setup(format!(
        "a dialog is open in the dev window and would stop the terminal from painting; \
         dismiss it and re-run — {remaining}"
    )))
}

/// Runs one scenario against `tab_id` and returns its samples.
pub fn run(
    driver: &Driver,
    tab_id: &str,
    scenario: Scenario,
    options: &ScenarioOptions,
) -> BenchResult<ScenarioRun> {
    clear_modals(driver)?;
    wait_ready(
        driver,
        tab_id,
        &scenario.to_string(),
        scenario.uses_payload_status(),
        scenario.expects_mouse_capture(),
    )?;
    let started = driver.eval(&format!(
        "{}.start({})",
        CONSTANTS.bench.runner_global,
        json!({
            "tabId": tab_id,
            "scenario": scenario.wire(),
            "count": options.count,
            "gapMs": options.gap_ms,
            "timeoutMs": options.timeout_ms,
            "deltaY": options.delta_y,
            "markerPrefix": CONSTANTS.bench.marker_prefix,
            "text": TYPING_TEXT,
        })
    ))?;
    if started.get("started").and_then(Value::as_bool) != Some(true) {
        let reason = started
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("the page did not say why");
        return Err(BenchError::Eval(format!(
            "{scenario} did not start: {reason}"
        )));
    }

    let deadline = scenario_deadline(options);
    let started_at = Instant::now();
    let mut consecutive_failures = 0_u32;
    loop {
        thread::sleep(POLL_INTERVAL);
        // A failed poll is not a failed scenario. The measurement loop lives in
        // the page and keeps running regardless; this call only reads its
        // progress, and the CLI's own HTTP timeout does fire under load — a busy
        // window redrawing 5000 lines is exactly when it is slowest to answer.
        // Give up only when the window has been unreachable for a long stretch.
        let progress = match driver.eval(&format!("{}.poll()", CONSTANTS.bench.runner_global)) {
            Ok(progress) => {
                consecutive_failures = 0;
                progress
            }
            Err(error) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_POLL_FAILURES {
                    return Err(error);
                }
                continue;
            }
        };
        if let Some(error) = progress.get("error").and_then(Value::as_str) {
            return Err(BenchError::Eval(format!("{scenario}: {error}")));
        }
        let sent =
            usize::try_from(progress.get("sent").and_then(Value::as_u64).unwrap_or(0)).unwrap_or(0);
        if progress.get("running").and_then(Value::as_bool) == Some(false) {
            let samples = progress
                .get("samples")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                .unwrap_or_default();
            let dropped =
                usize::try_from(progress.get("dropped").and_then(Value::as_u64).unwrap_or(0))
                    .unwrap_or(0);
            check_wheel_ownership(scenario, &progress)?;
            let summary = Summary::new(&samples, dropped);
            return Ok(ScenarioRun {
                scenario,
                samples,
                summary,
                sent,
                unfocused: progress.get("unfocused").and_then(Value::as_bool) == Some(true),
            });
        }
        print!("\r  {scenario}: {sent}/{} inputs", options.count);
        let _ = std::io::stdout().flush();
        if started_at.elapsed() > deadline {
            return Err(BenchError::Timeout {
                what: format!("{scenario} to finish ({sent}/{} sent)", options.count),
                waited: started_at.elapsed(),
            });
        }
    }
}

/// Waits until a background load tab is mounted and painting its status row.
///
/// The same readiness check the measured scenarios use, minus the mouse-mode
/// requirement: a load tab is never driven, so which half of the wheel path it
/// owns does not matter. What does matter is that it is really running — a tab
/// whose PTY has not started yet contributes no load at all, and the run would
/// quietly measure a window emptier than the one it claims.
pub fn wait_painted(driver: &Driver, tab_id: &str) -> BenchResult<()> {
    wait_ready(driver, tab_id, "load tab", true, None)
}

/// Waits until the app has a terminal for `tab_id` and — when it runs the TUI
/// payload — until that payload has painted its status row.
///
/// `expects_capture` is the caller's requirement on xterm's mouse-tracking mode:
/// `Some(true)` for a scenario whose wheel must reach the payload, `Some(false)`
/// for one that must scroll xterm's own scrollback, `None` when it is irrelevant.
fn wait_ready(
    driver: &Driver,
    tab_id: &str,
    what: &str,
    uses_payload_status: bool,
    expects_capture: Option<bool>,
) -> BenchResult<()> {
    let marker = if uses_payload_status {
        Value::String(CONSTANTS.bench.marker_prefix.as_str().to_owned())
    } else {
        Value::Null
    };
    let expression = format!(
        "{}.ready({}, {marker})",
        CONSTANTS.bench.runner_global,
        json!(tab_id)
    );
    let started = Instant::now();
    let mut last_reason = String::from("the app has not mounted the tab yet");
    while started.elapsed() < READY_TIMEOUT {
        // A failed probe is a "not yet", not a fatal error: this window is
        // booting or reloading, and the app is at its least responsive exactly
        // when this loop runs. Only running out of time is fatal, and it reports
        // whatever the last probe said.
        match driver.eval(&expression) {
            Ok(state) => {
                if state.get("ready").and_then(Value::as_bool) == Some(true) {
                    // Mouse capture is checked here, not at the first sample:
                    // the payload turns it on as it starts, so a terminal that
                    // has painted the status row but is still in the shell's
                    // mouse mode is a race worth waiting out, and one that never
                    // gets there is a setup failure worth naming.
                    match mouse_mismatch(expects_capture, &state) {
                        None => return Ok(()),
                        Some(problem) => last_reason = problem,
                    }
                } else if let Some(reason) = state.get("reason").and_then(Value::as_str) {
                    last_reason = reason.to_string();
                }
            }
            Err(error) => last_reason = error.to_string(),
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(BenchError::Timeout {
        what: format!("the {what} payload to be drivable ({last_reason})"),
        waited: started.elapsed(),
    })
}

/// Describes a terminal whose mouse mode is not what the caller requires, or
/// `None` when it is (or when the caller does not care).
///
/// `mouse` is xterm's own `modes.mouseTrackingMode`, the same value
/// `TerminalManager` gates its wheel pacing on. Anything other than `none` means
/// the program on the PTY asked for mouse reports and xterm is sending them.
fn mouse_mismatch(expects_capture: Option<bool>, state: &Value) -> Option<String> {
    let expected = expects_capture?;
    let mode = state
        .get("mouse")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    // `unknown` means this xterm build exposes no `modes` — not proof of either
    // answer, so it can never satisfy a scenario that requires capture.
    let capturing = !matches!(mode, "none" | "unknown");
    if capturing == expected {
        return None;
    }
    Some(if expected {
        format!(
            "the terminal is not in mouse-tracking mode (mouseTrackingMode={mode}), so a wheel \
             notch would scroll xterm's own buffer instead of reaching the TUI — the payload has \
             not enabled mouse capture yet, or is not the program on the PTY"
        )
    } else {
        format!(
            "the terminal is in mouse-tracking mode (mouseTrackingMode={mode}), so wheel notches \
             would go to the program on the PTY instead of xterm's scrollback — this tab is \
             running a TUI, not the scrollback payload"
        )
    })
}

/// Refuses a finished scroll run whose wheel went to the wrong half of the app.
///
/// The readiness check proves mouse capture was on before the first notch; this
/// proves it stayed on, and that xterm never moved its own viewport behind the
/// payload's back. Either would turn later samples into scrollback paints
/// reported under the TUI scenario's name — a wrong number, which is worse than
/// no number.
fn check_wheel_ownership(scenario: Scenario, progress: &Value) -> BenchResult<()> {
    if scenario.expects_mouse_capture() != Some(true) {
        return Ok(());
    }
    let flagged = |key: &str| progress.get(key).and_then(Value::as_bool) == Some(true);
    if flagged("mouseLost") {
        return Err(BenchError::Eval(format!(
            "{scenario}: the terminal left mouse-tracking mode mid-run, so the TUI stopped \
             receiving the wheel — did the payload exit?"
        )));
    }
    if flagged("xtermScrolled") {
        return Err(BenchError::Eval(format!(
            "{scenario}: xterm scrolled its own viewport, so these samples are scrollback paints \
             rather than TUI redraws — the payload is not intercepting the wheel"
        )));
    }
    Ok(())
}

/// Generous ceiling for a whole scenario: every input may time out, and each
/// then costs its timeout plus its gap.
fn scenario_deadline(options: &ScenarioOptions) -> Duration {
    let per_input = Duration::from_millis(options.timeout_ms + options.gap_ms);
    per_input * u32::try_from(options.count).unwrap_or(u32::MAX) + Duration::from_secs(30)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runner_source_carries_a_config_placeholder() {
        assert!(
            RUNNER_JS.contains(CONFIG_PLACEHOLDER),
            "runner.js must keep its config placeholder for install() to substitute"
        );
    }

    #[test]
    fn wire_names_match_the_runners_branches() {
        for scenario in [
            Scenario::Typing,
            Scenario::ScrollTui,
            Scenario::ScrollBuffer,
        ] {
            assert!(
                RUNNER_JS.contains(&format!("\"{}\"", scenario.wire())),
                "runner.js does not branch on {scenario}"
            );
        }
    }

    #[test]
    fn the_runner_reports_every_integrity_flag_this_module_reads() {
        for key in ["mouse", "mouseLost", "xtermScrolled"] {
            assert!(
                RUNNER_JS.contains(key),
                "runner.js never reports {key}, which the wheel-ownership check requires"
            );
        }
    }

    #[test]
    fn only_the_payload_backed_scenarios_read_the_status_row() {
        assert!(Scenario::Typing.uses_payload_status());
        assert!(Scenario::ScrollTui.uses_payload_status());
        assert!(!Scenario::ScrollBuffer.uses_payload_status());
    }

    #[test]
    fn typing_text_holds_only_keys_a_synthetic_keydown_can_deliver() {
        // A space would be dispatched and never arrive — see TYPING_TEXT.
        assert!(TYPING_TEXT.chars().all(|c| c.is_ascii_lowercase()));
    }

    #[test]
    fn scroll_tui_demands_mouse_capture_and_scroll_buffer_refuses_it() {
        let tracking = json!({ "mouse": "any" });
        let plain = json!({ "mouse": "none" });
        let expects = Scenario::expects_mouse_capture;
        assert!(mouse_mismatch(expects(Scenario::ScrollTui), &tracking).is_none());
        assert!(mouse_mismatch(expects(Scenario::ScrollTui), &plain).is_some());
        assert!(mouse_mismatch(expects(Scenario::ScrollBuffer), &plain).is_none());
        assert!(mouse_mismatch(expects(Scenario::ScrollBuffer), &tracking).is_some());
        // Typing reaches the PTY either way, so it never blocks on the mode.
        assert!(mouse_mismatch(expects(Scenario::Typing), &plain).is_none());
        assert!(mouse_mismatch(expects(Scenario::Typing), &tracking).is_none());
        // A load tab is not driven at all, so neither mode disqualifies it.
        assert!(mouse_mismatch(None, &plain).is_none());
        assert!(mouse_mismatch(None, &tracking).is_none());
    }

    #[test]
    fn an_xterm_without_a_readable_mouse_mode_cannot_satisfy_scroll_tui() {
        let unknown = json!({});
        assert!(mouse_mismatch(Scenario::ScrollTui.expects_mouse_capture(), &unknown).is_some());
        assert!(mouse_mismatch(Scenario::ScrollBuffer.expects_mouse_capture(), &unknown).is_none());
    }

    #[test]
    fn a_scroll_tui_run_that_lost_the_wheel_is_not_reported_as_a_measurement() {
        let clean = json!({ "mouseLost": false, "xtermScrolled": false });
        assert!(check_wheel_ownership(Scenario::ScrollTui, &clean).is_ok());
        assert!(check_wheel_ownership(Scenario::ScrollTui, &json!({ "mouseLost": true })).is_err());
        assert!(
            check_wheel_ownership(Scenario::ScrollTui, &json!({ "xtermScrolled": true })).is_err()
        );
        // The scrollback scenario is *supposed* to move xterm's viewport.
        assert!(
            check_wheel_ownership(Scenario::ScrollBuffer, &json!({ "xtermScrolled": true }))
                .is_ok()
        );
    }

    #[test]
    fn the_deadline_covers_every_input_timing_out() {
        let options = ScenarioOptions {
            count: 10,
            gap_ms: 5,
            timeout_ms: 100,
            delta_y: 120.0,
        };
        assert!(scenario_deadline(&options) >= Duration::from_millis(1050));
    }
}
