use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use pragma_constants::CONSTANTS;
use pragma_protocol::{read_json_frame, write_json_frame, RequestFrame, RequestKind, ServerFrame};

#[derive(Debug, Parser)]
#[command(
    name = "pragma-agent",
    about = "Report external agent status to Pragma"
)]
struct Cli {
    /// Stable agent id from the agent config. Must be passed before the
    /// subcommand (`pragma-agent --agent <id> report ...`). Not a clap `global`
    /// arg: clap globals cannot be required, and marking a required arg global
    /// makes clap re-demand it at every subcommand level even when it is given.
    #[arg(long)]
    agent: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Reports status for the current Pragma terminal tab.
    Report {
        #[command(subcommand)]
        report: ReportCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ReportCommand {
    Started,
    Stopped {
        /// Overrides `PRAGMA_WORKTREE_ID`, useful when reporting final status from a parent process.
        #[arg(long)]
        worktree_id: Option<String>,
    },
    Attention {
        #[arg(long)]
        kind: AttentionKind,
    },
    /// Clears the tab's indicator entirely instead of leaving a `done`/green dot.
    /// Use when the agent process exits rather than finishing a turn.
    Cleared {
        /// Overrides `PRAGMA_WORKTREE_ID`, useful when clearing final status from a parent process.
        #[arg(long)]
        worktree_id: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum AttentionKind {
    Question,
    Command,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pragma-agent: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let socket = env_required("PRAGMA_DAEMON_SOCKET")?;
    let tab_id = env_required("PRAGMA_TAB_ID")?;
    let (status, attention_kind, worktree_override) = match cli.command {
        Command::Report { report } => match report {
            ReportCommand::Started => ("running", None, None),
            ReportCommand::Stopped { worktree_id } => ("done", None, worktree_id),
            ReportCommand::Attention { kind } => (
                "attention",
                Some(match kind {
                    AttentionKind::Question => "question",
                    AttentionKind::Command => "command",
                }),
                None,
            ),
            ReportCommand::Cleared { worktree_id } => ("cleared", None, worktree_id),
        },
    };
    let worktree_id = worktree_override.unwrap_or(env_required("PRAGMA_WORKTREE_ID")?);
    let payload = serde_json::json!({
        "agent": cli.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "status": status,
        "attentionKind": attention_kind,
    });
    let frame = RequestFrame {
        request_id: format!("agent-{}", std::process::id()),
        kind: RequestKind::AgentReport,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: Some(payload.to_string()),
    };
    let mut stream = UnixStream::connect(&socket)
        .map_err(|error| format!("failed to connect to daemon socket {socket}: {error}"))?;
    let expected = CONSTANTS.daemon.protocol_version.get();
    match read_json_frame::<ServerFrame>(&mut stream) {
        Ok(ServerFrame::Hello(hello)) if hello.protocol_version == expected => {}
        Ok(ServerFrame::Hello(hello)) => {
            return Err(format!(
                "daemon protocol mismatch: expected {expected}, got {}",
                hello.protocol_version
            ));
        }
        Ok(ServerFrame::Response(_) | ServerFrame::Event(_)) => {
            return Err("daemon did not send hello frame".to_string());
        }
        Err(error) => return Err(format!("failed to read daemon hello: {error}")),
    }
    write_json_frame(&mut stream, &frame)
        .map_err(|error| format!("failed to report status: {error}"))
}

fn env_required(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// `--agent` must be accepted before the subcommand. A regression guard for
    /// when it was declared `global = true`: clap globals cannot be required, so
    /// marking it global made clap re-demand `--agent` at the subcommand level
    /// and **every** invocation failed even with `--agent` provided.
    #[test]
    fn agent_flag_is_accepted_before_subcommand() {
        let cli = Cli::try_parse_from(["pragma-agent", "--agent", "mock", "report", "started"])
            .expect("--agent before the subcommand should parse");
        assert_eq!(cli.agent, "mock");
        assert!(matches!(
            cli.command,
            Command::Report {
                report: ReportCommand::Started
            }
        ));
    }

    #[test]
    fn attention_requires_a_kind() {
        let cli = Cli::try_parse_from([
            "pragma-agent",
            "--agent",
            "mock",
            "report",
            "attention",
            "--kind",
            "question",
        ])
        .expect("attention with a kind should parse");
        assert_eq!(cli.agent, "mock");
    }

    #[test]
    fn cleared_accepts_optional_worktree_override() {
        let cli = Cli::try_parse_from([
            "pragma-agent",
            "--agent",
            "mock",
            "report",
            "cleared",
            "--worktree-id",
            "wt-1",
        ])
        .expect("cleared with a worktree override should parse");
        assert!(matches!(
            cli.command,
            Command::Report {
                report: ReportCommand::Cleared {
                    worktree_id: Some(ref id)
                }
            } if id == "wt-1"
        ));
    }

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }
}
