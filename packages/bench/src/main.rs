//! `pragma-bench` — terminal lag benchmark for Pragma.
//!
//! Three commands, two of which are payloads that run *inside* a Pragma
//! terminal and one of which drives them:
//!
//! - `pragma-bench tui` — the ratatui payload: 5000 scrollable lines, its own
//!   mouse capture, and a machine-readable status row.
//! - `pragma-bench lines` — the same corpus dumped into xterm's scrollback.
//! - `pragma-bench run` — launches a Pragma dev instance, opens the payloads in
//!   real terminal tabs, and measures how long each keystroke and each wheel
//!   notch takes to reach the screen.
//!
//! Nothing here is headless: the point is to measure the renderer, the webview,
//! and the desktop app's own input pacing, none of which exist without a window.

mod bridge;
mod corpus;
mod driver;
mod error;
mod instance;
mod lines;
mod report;
mod run;
mod scenarios;
mod stats;
mod tui;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use pragma_constants::CONSTANTS;

use crate::corpus::DEFAULT_LINES;
use crate::run::{DEFAULT_LOAD_INTERVAL_MS, DEFAULT_TABS};

#[derive(Debug, Parser)]
#[command(
    name = "pragma-bench",
    about = "Terminal lag benchmark: drives a real Pragma dev instance and measures render latency."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the benchmark: launch a dev instance, drive it, write a report.
    Run(RunArgs),
    /// Payload: the scrollable ratatui TUI the benchmark types into.
    Tui(TuiArgs),
    /// Payload: dump the corpus into xterm's scrollback and park.
    Lines(LinesArgs),
}

#[derive(Debug, clap::Args)]
struct RunArgs {
    /// Keystrokes sent to the TUI payload.
    #[arg(long, default_value_t = 300)]
    keystrokes: usize,
    /// Wheel notches sent in each of the two scroll scenarios.
    #[arg(long, default_value_t = 200)]
    scroll_ticks: usize,
    /// Scrollable lines in both payloads.
    #[arg(long, default_value_t = DEFAULT_LINES)]
    lines: usize,
    /// Terminal tabs open while a scenario runs, counting the measured one. The
    /// other `--tabs - 1` run the TUI payload on a timer for the whole
    /// benchmark, so the measurement happens under the load of a real workspace.
    /// `1` measures an otherwise idle window.
    #[arg(long, default_value_t = DEFAULT_TABS)]
    tabs: usize,
    /// Repaint interval of each background load tab.
    #[arg(long, default_value_t = DEFAULT_LOAD_INTERVAL_MS)]
    load_interval_ms: u64,
    /// Scroll pacing: pause after a wheel notch moved the screen, before the next.
    #[arg(long, default_value_t = 16)]
    gap_ms: u64,
    /// Typing pacing: delay between consecutive keystrokes. Keystrokes are sent
    /// as a burst and never wait for each other, so `0` types as fast as the
    /// page can dispatch — which is the point of the scenario.
    #[arg(long, default_value_t = 0)]
    typing_gap_ms: u64,
    /// How long one input may take to reach the screen before it counts as dropped.
    #[arg(long, default_value_t = 2000)]
    timeout_ms: u64,
    /// Wheel distance per notch, in pixels, as a trackpad reports it.
    #[arg(long, default_value_t = 120.0)]
    delta_y: f64,
    /// Ceiling on dev-instance start-up, which may include a full cargo build.
    #[arg(long, default_value_t = 900)]
    startup_timeout_secs: u64,
    /// Where the JSON report is written.
    #[arg(long, default_value = "bench-report.json")]
    out: PathBuf,
    /// Leave the dev instance running after the benchmark finishes.
    #[arg(long)]
    keep_open: bool,
    /// Run only these scenarios (default: all three).
    #[arg(long, value_delimiter = ',')]
    only: Vec<String>,
}

#[derive(Debug, clap::Args)]
struct TuiArgs {
    /// Scrollable lines in the corpus.
    #[arg(long, default_value_t = DEFAULT_LINES)]
    lines: usize,
    /// Lines advanced per wheel notch.
    #[arg(long, default_value_t = 3)]
    step: usize,
    /// Repaint on this interval instead of waiting for input — how a background
    /// load tab runs. Omitted, the payload paints once per input event, which is
    /// what makes a frame attributable to the keystroke that caused it.
    #[arg(long)]
    auto_ms: Option<u64>,
}

#[derive(Debug, clap::Args)]
struct LinesArgs {
    /// Lines written to the scrollback.
    #[arg(long, default_value_t = DEFAULT_LINES)]
    lines: usize,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run(args) => run::execute(&args_to_run_options(&args)),
        Command::Tui(args) => tui::run(&tui::TuiOptions {
            lines: args.lines,
            step: args.step,
            marker_prefix: CONSTANTS.bench.marker_prefix.as_str().to_owned(),
            auto_ms: args.auto_ms,
        })
        .map_err(Into::into),
        Command::Lines(args) => lines::run(args.lines).map_err(Into::into),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pragma-bench: {error}");
            ExitCode::FAILURE
        }
    }
}

fn args_to_run_options(args: &RunArgs) -> run::RunOptions {
    run::RunOptions {
        keystrokes: args.keystrokes,
        scroll_ticks: args.scroll_ticks,
        lines: args.lines,
        tabs: args.tabs,
        load_interval_ms: args.load_interval_ms,
        gap_ms: args.gap_ms,
        typing_gap_ms: args.typing_gap_ms,
        timeout_ms: args.timeout_ms,
        delta_y: args.delta_y,
        startup_timeout: Duration::from_secs(args.startup_timeout_secs),
        out: args.out.clone(),
        keep_open: args.keep_open,
        only: args.only.clone(),
    }
}
