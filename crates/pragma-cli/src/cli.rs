//! clap definitions for the whole `pragma-cli` subcommand tree.
//!
//! Global form: `pragma-cli [--json] <group> <command> ...`.
//! `--worktree <id>` and `worktree create --parent <id>` default to
//! `$PRAGMA_WORKTREE_ID` when omitted.

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Top-level CLI. Every command supports `--json`; `--worktree` hosts its own
/// per-subcommand flag (clap globals cannot be required, so we surface
/// `--worktree` exactly where it is meaningful instead).
#[derive(Debug, Parser)]
#[command(
    name = "pragma-cli",
    about = "Terminal control surface for Pragma: worktrees, tabs, splits, browser, and agents."
)]
pub struct Cli {
    /// Emit structured JSON for scripting. Default is plain text (lists render
    /// as aligned columns; single objects as a short human line). Data goes to
    /// stdout, errors to stderr.
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: TopCommand,
}

#[derive(Debug, Subcommand)]
pub enum TopCommand {
    /// Worktree lifecycle: list, create, rename, hide, delete.
    Worktree {
        #[command(subcommand)]
        worktree: WorktreeCommand,
    },
    /// Tabs: list, read scrollback/output, open, close, rename, exec.
    Tab {
        #[command(subcommand)]
        tab: TabCommand,
    },
    /// Split-pane layouts.
    Split {
        #[command(subcommand)]
        split: SplitCommand,
    },
    /// Browser webview tab control.
    Browser {
        #[command(subcommand)]
        browser: BrowserCommand,
    },
    /// Agent lifecycle: start, status (live), report (status reports from plugins).
    Agent {
        #[command(subcommand)]
        agent: AgentCommand,
    },
}

// -------------------------- worktree --------------------------

#[derive(Debug, Subcommand)]
pub enum WorktreeCommand {
    /// List worktrees for the current project (`is_main` row first).
    List {
        #[command(flatten)]
        worktree: OptionalWorktree,
    },
    /// Create a worktree under a parent. The app handles the git worktree + DB row + setup scripts.
    Create(WorktreeCreateArgs),
    /// Rename a worktree's display title (empty string clears it).
    Rename { id: String, title: String },
    /// Hide a worktree from the sidebar.
    Hide { id: String },
    /// Unhide a worktree.
    Unhide { id: String },
    /// Delete a worktree (refuses dirty trees without `--force`).
    Delete(WorktreeDeleteArgs),
}

/// `--worktree` is optional on `worktree list`. Each subcommand owns its own
/// flag so clap doesn't demand it globally.
#[derive(Debug, Args)]
pub struct OptionalWorktree {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WorktreeCreateArgs {
    /// Parent worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub parent: Option<String>,
    /// Branch to create the worktree on.
    #[arg(long)]
    pub branch: String,
    /// Optional display title.
    #[arg(long)]
    pub title: Option<String>,
}

#[derive(Debug, Args)]
pub struct WorktreeDeleteArgs {
    pub id: String,
    /// Drop the branch too.
    #[arg(long)]
    pub delete_branch: bool,
    /// Proceed even when the worktree is dirty.
    #[arg(long)]
    pub force: bool,
}

// -------------------------- tab --------------------------

#[derive(Debug, Subcommand)]
pub enum TabCommand {
    /// List tabs in a worktree (or the whole project with `--all`).
    List(TabListArgs),
    /// Read a terminal tab's scrollback/output. Direct to the server — works
    /// with the app closed. Server scrollback is a capped frame buffer, not the
    /// full history; `--lines`/`--bytes` are best-effort over that window.
    Read(TabReadArgs),
    /// Open a new tab.
    Open(TabOpenArgs),
    /// Close a tab.
    Close { tab: String },
    /// Rename a tab's display title (a live shell may later reclaim a terminal tab's title via OSC).
    Rename { tab: String, title: String },
    /// Run a command in a worktree without a tab, capturing stdout/stderr/exit.
    Exec(TabExecArgs),
}

#[derive(Debug, Args)]
pub struct TabListArgs {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// List tabs across the whole project.
    #[arg(long)]
    pub all: bool,
}

#[derive(Debug, Args)]
pub struct TabReadArgs {
    pub tab: String,
    /// Tail the last N lines (default 1000).
    #[arg(long, default_value_t = 1000)]
    pub lines: usize,
    /// Skip N lines from the chosen end before emitting.
    #[arg(long, default_value_t = 0)]
    pub offset: usize,
    /// Raw byte budget instead of lines.
    #[arg(long)]
    pub bytes: Option<usize>,
    /// Strip ANSI/OSC escapes (default).
    #[arg(long, conflicts_with = "raw")]
    pub plain: bool,
    /// Emit bytes verbatim for piping.
    #[arg(long, conflicts_with = "plain")]
    pub raw: bool,
    /// Print scrollback then stay attached and stream new output until the
    /// session exits or Ctrl-C.
    #[arg(long)]
    pub watch: bool,
}

#[derive(Debug, Args)]
pub struct TabOpenArgs {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Kind of tab to open.
    #[arg(long, value_enum)]
    pub kind: TabKindArg,
    /// Start command for a terminal tab.
    #[arg(long)]
    pub command: Option<String>,
    /// Starting URL for a browser tab.
    #[arg(long)]
    pub url: Option<String>,
    /// Worktree-relative path for an editor/diff tab.
    #[arg(long)]
    pub file: Option<String>,
    /// Diff side for a diff tab.
    #[arg(long, value_enum)]
    pub diff_side: Option<DiffSideArg>,
    /// Optional display title.
    #[arg(long)]
    pub title: Option<String>,
}

#[derive(Debug, Args)]
pub struct TabExecArgs {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Command and args to run (after `--`).
    #[arg(last = true, required = true)]
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum TabKindArg {
    Terminal,
    Browser,
    Editor,
    Diff,
    Log,
    #[value(name = "pr-review")]
    PrReview,
}

impl TabKindArg {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Browser => "browser",
            Self::Editor => "editor",
            Self::Diff => "diff",
            Self::Log => "log",
            Self::PrReview => "pr-review",
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum DiffSideArg {
    Committed,
    Staged,
    Unstaged,
    Worktree,
}

impl DiffSideArg {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Committed => "committed",
            Self::Staged => "staged",
            Self::Unstaged => "unstaged",
            Self::Worktree => "worktree",
        }
    }
}

// -------------------------- split --------------------------

#[derive(Debug, Subcommand)]
pub enum SplitCommand {
    /// Set a worktree's split layout from a recursive tree (or `-` to read JSON from stdin).
    Set(SplitSetArgs),
    /// Read-modify-write: graft a new pane on a side of the current layout.
    AddTab(SplitAddTabArgs),
    /// Collapse back to a single pane.
    Clear {
        #[arg(long, value_name = "ID")]
        worktree: String,
    },
}

#[derive(Debug, Args)]
pub struct SplitSetArgs {
    #[arg(long, value_name = "ID")]
    pub worktree: String,
    /// JSON layout, or `-` to read from stdin.
    #[arg(value_name = "JSON|-")]
    pub layout: String,
}

#[derive(Debug, Args)]
pub struct SplitAddTabArgs {
    #[arg(long, value_name = "ID")]
    pub worktree: String,
    /// Where to graft the pane.
    #[arg(long, value_enum)]
    pub side: SideArg,
    /// Kind of tab to add.
    #[arg(long, value_enum)]
    pub kind: TabKindArg,
    #[arg(long)]
    pub command: Option<String>,
    #[arg(long)]
    pub url: Option<String>,
    #[arg(long)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SideArg {
    Left,
    Right,
    Top,
    Bottom,
}

impl SideArg {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }
}

// -------------------------- browser --------------------------

#[derive(Debug, Subcommand)]
pub enum BrowserCommand {
    Navigate {
        tab: String,
        url: String,
    },
    Back {
        tab: String,
    },
    Forward {
        tab: String,
    },
    Reload {
        tab: String,
    },
    Close {
        tab: String,
    },
    Scroll(BrowserScrollArgs),
    Focus {
        tab: String,
        selector: String,
    },
    Click {
        tab: String,
        selector: String,
    },
    Screenshot(BrowserScreenshotArgs),
    /// Run JavaScript in the page. `-` reads the script from stdin.
    Exec {
        tab: String,
        js: String,
    },
}

#[derive(Debug, Args)]
pub struct BrowserScrollArgs {
    pub tab: String,
    /// Scroll by this many pixels on the X axis.
    #[arg(long, default_value_t = 0)]
    pub x: i64,
    /// Scroll by this many pixels on the Y axis.
    #[arg(long, default_value_t = 0)]
    pub y: i64,
    /// Jump to an anchor instead of scrolling by deltas.
    #[arg(long, value_enum)]
    pub to: Option<ScrollAnchorArg>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ScrollAnchorArg {
    Top,
    Bottom,
}

#[derive(Debug, Args)]
pub struct BrowserScreenshotArgs {
    pub tab: String,
    /// Write the PNG here. Without `--out`, a default path is chosen.
    #[arg(long, value_name = "FILE")]
    pub out: Option<String>,
}

// -------------------------- agent --------------------------

#[derive(Debug, Subcommand)]
pub enum AgentCommand {
    /// Start an agent in a new terminal tab. Brokered through the app.
    Start(AgentStartArgs),
    /// Print one row per agent with its tabId. Direct to the server (works with
    /// the app closed). `--watch` keeps the subscription open and prints deltas.
    Status(AgentStatusArgs),
    /// Report an external agent's status to the server. Direct to the server;
    /// the reporting logic is the same as before, only the command path moved.
    Report(AgentReportArgs),
}

#[derive(Debug, Args)]
pub struct AgentStartArgs {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Agent id (from `~/.pragma/agents/<id>/config.json`).
    #[arg(long)]
    pub agent: String,
    /// Model id to launch with (optional).
    #[arg(long)]
    pub model: Option<String>,
    /// Prompt prefill to send once the agent is ready (optional).
    #[arg(long)]
    pub prompt: Option<String>,
}

#[derive(Debug, Args)]
pub struct AgentStatusArgs {
    /// Filter to a worktree. Defaults to `$PRAGMA_WORKTREE_ID` when set.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Keep the subscription open and print each delta as agents change state.
    #[arg(long)]
    pub watch: bool,
}

#[derive(Debug, Args)]
pub struct AgentReportArgs {
    /// Stable agent id from the agent config.
    #[arg(long)]
    pub agent: String,
    #[command(subcommand)]
    pub report: AgentReportCommand,
}

#[derive(Debug, Subcommand)]
pub enum AgentReportCommand {
    Started,
    Stopped {
        /// Overrides `PRAGMA_WORKTREE_ID`, useful when reporting final status from a parent process.
        #[arg(long, value_name = "ID")]
        worktree_id: Option<String>,
    },
    Attention {
        /// Optional hint for the kind of attention needed. Omit when the host
        /// agent can't tell a question from a command so Pragma shows a generic
        /// attention indicator.
        #[arg(long, value_enum)]
        kind: Option<AttentionKindArg>,
    },
    /// Clears the tab's indicator entirely instead of leaving a `done`/green dot.
    /// Use when the agent process exits rather than finishing a turn.
    Cleared {
        /// Overrides `PRAGMA_WORKTREE_ID`, useful when clearing final status from a parent process.
        #[arg(long, value_name = "ID")]
        worktree_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum AttentionKindArg {
    Question,
    Command,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn worktree_create_parent_is_optional() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "worktree",
            "create",
            "--branch",
            "feature/demo",
        ])
        .expect("worktree create can default parent from PRAGMA_WORKTREE_ID");
        let TopCommand::Worktree {
            worktree: WorktreeCommand::Create(args),
        } = cli.command
        else {
            panic!("expected worktree create");
        };
        assert_eq!(args.parent, None);
        assert_eq!(args.branch, "feature/demo");
    }

    #[test]
    fn agent_report_started_parses() {
        let cli = Cli::try_parse_from(["pragma-cli", "agent", "report", "--agent", "x", "started"])
            .expect("agent report --agent x started parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(AgentReportArgs { agent, report }),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        assert_eq!(agent, "x");
        assert!(matches!(report, AgentReportCommand::Started));
    }

    #[test]
    fn agent_report_attention_with_kind_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "mock",
            "attention",
            "--kind",
            "question",
        ])
        .expect("attention with kind parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(AgentReportArgs { report, .. }),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        assert!(matches!(
            report,
            AgentReportCommand::Attention {
                kind: Some(AttentionKindArg::Question)
            }
        ));
    }

    #[test]
    fn agent_report_attention_optional_kind_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "mock",
            "attention",
        ])
        .expect("attention without kind parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(AgentReportArgs { report, .. }),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        assert!(matches!(
            report,
            AgentReportCommand::Attention { kind: None }
        ));
    }

    /// The old top-level `pragma-cli --agent <id> report ...` form is removed
    /// and must be rejected as an unknown invocation.
    #[test]
    fn old_top_level_report_form_is_rejected() {
        let result = Cli::try_parse_from(["pragma-cli", "--agent", "x", "report", "started"]);
        assert!(
            result.is_err(),
            "old top-level --agent report form must not parse"
        );
    }

    #[test]
    fn global_json_flag_parses_anywhere() {
        let cli = Cli::try_parse_from(["pragma-cli", "--json", "agent", "status"])
            .expect("--json before group works");
        assert!(cli.json);
        let cli = Cli::try_parse_from(["pragma-cli", "agent", "--json", "status"])
            .expect("--json after group works");
        assert!(cli.json);
    }

    #[test]
    fn browser_exec_dash_arg_is_literal() {
        let cli = Cli::try_parse_from(["pragma-cli", "browser", "exec", "t1", "-"])
            .expect("browser exec - reads from stdin");
        let TopCommand::Browser {
            browser: BrowserCommand::Exec { tab, js },
        } = cli.command
        else {
            panic!("expected browser exec");
        };
        assert_eq!(tab, "t1");
        assert_eq!(js, "-");
    }
}
