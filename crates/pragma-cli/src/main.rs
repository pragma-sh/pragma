//! pragma-cli — terminal control surface for Pragma.
//!
//! Plain text by default (`comfy-table` for lists, short human lines for
//! single objects); `--json` emits structured JSON, `--toon` emits
//! token-efficient TOON. `worktree list` and the GUI-driven commands need the
//! app; `tab read`, `agent status`, and `agent report` are direct-to-server
//! and work with the app closed.

use std::process::ExitCode;

use clap::Parser;

mod broker;
mod cli;
mod commands;
mod direct;
mod output;
mod scrollback;
mod server;

use cli::{AgentCommand, Cli, TabCommand, TopCommand};
use server::CliError;

fn main() -> ExitCode {
    let cli = Cli::parse();
    let out = output::Output {
        format: cli.format(),
    };
    match run(&cli, &out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::AppNotRunning) => {
            eprintln!("error: {CliError}", CliError = CliError::AppNotRunning);
            ExitCode::FAILURE
        }
        Err(CliError::Config(message)) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli, out: &output::Output) -> Result<(), CliError> {
    match &cli.command {
        TopCommand::Worktree { worktree } => commands::worktree(worktree, out),
        TopCommand::Tab { tab } => match tab {
            TabCommand::List(args) => commands::tab_list(args, out),
            TabCommand::Read(args) => direct::tab_read(args, out),
            TabCommand::Open(args) => commands::tab_open(args, out),
            TabCommand::Close { tab } => commands::tab_close(tab, out),
            TabCommand::Rename { tab, title } => commands::tab_rename(tab, title, out),
            TabCommand::Exec(args) => commands::tab_exec(args, out),
        },
        TopCommand::Split { split } => commands::split(split, out),
        TopCommand::Browser { browser } => commands::browser(browser, out),
        TopCommand::Agent { agent } => match agent {
            AgentCommand::Start(args) => commands::agent_start(args, out),
            AgentCommand::Status(args) => direct::agent_status(args, out),
            AgentCommand::Report(args) => direct::agent_report(args, out),
        },
    }
}
