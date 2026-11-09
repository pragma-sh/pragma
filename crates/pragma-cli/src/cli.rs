//! clap definitions for the whole `pragma-cli` subcommand tree.
//!
//! Global form: `pragma-cli [--json|--toon] <group> <command> ...`.
//! `--worktree <id>` and `worktree create --parent <id>` default to
//! `$PRAGMA_WORKTREE_ID` when omitted.

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Top-level CLI. Every command supports `--json`/`--toon`; `--worktree` hosts
/// its own per-subcommand flag (clap globals cannot be required, so we
/// surface `--worktree` exactly where it is meaningful instead).
#[derive(Debug, Parser)]
#[command(
    name = "pragma-cli",
    about = "Terminal control surface for Pragma: worktrees, tabs, splits, browser, and agents."
)]
pub struct Cli {
    /// Emit structured JSON for scripting. Default is plain text (lists render
    /// as aligned columns; single objects as a short human line). Data goes to
    /// stdout, errors to stderr. Mutually exclusive with `--toon`.
    #[arg(long, global = true, conflicts_with = "toon")]
    pub json: bool,

    /// Emit structured TOON (Token-Oriented Object Notation) instead of JSON:
    /// a token-efficient format meant for LLM contexts. Mutually exclusive
    /// with `--json`.
    #[arg(long, global = true, conflicts_with = "json")]
    pub toon: bool,

    #[command(subcommand)]
    pub command: TopCommand,
}

impl Cli {
    /// Resolves the `--json`/`--toon` flags to the output format to render
    /// under. clap's `conflicts_with` guarantees at most one is set.
    pub fn format(&self) -> crate::output::Format {
        if self.json {
            crate::output::Format::Json
        } else if self.toon {
            crate::output::Format::Toon
        } else {
            crate::output::Format::Text
        }
    }
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
    /// Agent-authored MDX scratchpads.
    Scratchpad {
        #[command(subcommand)]
        scratchpad: ScratchpadCommand,
    },
    /// Fan one prompt out into several isolated agent attempts, then pick one.
    Fanout {
        #[command(subcommand)]
        fanout: FanoutCommand,
    },
    /// Worktree-scoped Excalidraw whiteboards.
    Whiteboard {
        #[command(subcommand)]
        whiteboard: WhiteboardCommand,
    },
    /// Read and control desktop apps (macOS): accessibility snapshots,
    /// screenshots, clicks, typing, and keys. Off until enabled in Pragma.
    Computer {
        #[command(subcommand)]
        computer: ComputerCommand,
    },
}

// -------------------------- computer --------------------------

/// Computer-use commands talk directly to `pragma-server`. Reads work with the
/// app closed; anything that clicks, types, or moves needs the Pragma window
/// open so the user can see and stop it. Call `computer end` when done.
#[derive(Debug, Subcommand)]
pub enum ComputerCommand {
    /// Running apps, or installed ones with `--installed`.
    Apps(ComputerAppsArgs),
    /// On-screen windows, optionally of one app.
    Windows(ComputerAppArgs),
    /// Attached displays and their scale.
    Displays,
    /// Launch an app in the background (a running one is left where it is).
    Open(ComputerOpenArgs),
    /// Make an app's window its target for keys, without bringing it forward.
    Focus(ComputerFocusArgs),
    /// An accessibility snapshot: the elements you can click and type into.
    Inspect(ComputerInspectArgs),
    /// Capture a window, an app's front window, a display, or a region.
    Screenshot(ComputerScreenshotArgs),
    /// Click an element (preferred) or a point.
    Click(ComputerClickArgs),
    /// Type text into the focused field or an element.
    Type(ComputerTypeArgs),
    /// Press keys and chords (`mod+l`, `enter`, `shift+tab`).
    Key(ComputerKeyArgs),
    /// Scroll an element, a point, or the app's front window.
    Scroll(ComputerScrollArgs),
    /// Move the pointer, or with `--visual-only` just point with the overlay.
    Move(ComputerMoveArgs),
    /// Drag between two elements or points.
    Drag(ComputerDragArgs),
    /// Your session, leases, approvals, and the helper's health.
    Status(ComputerStatusArgs),
    /// Run a durable, bounded computer task. Text must come from supplied inputs.
    Run(ComputerRunArgs),
    /// Resume a task after supplying missing inputs or a caller note.
    Resume(ComputerResumeArgs),
    /// Cancel one of your tasks. Already performed actions are kept.
    Cancel { task_id: String },
    /// End your session: release its apps and clear the indicator.
    End,
    /// The helper's Accessibility and Screen Recording permissions.
    Permissions(ComputerPermissionsArgs),
}

/// Names the app an operation targets.
#[derive(Debug, Args)]
pub struct ComputerAppArgs {
    /// App name, bundle id, `app:` id, or path. Defaults to the frontmost app.
    #[arg(long)]
    pub app: Option<String>,
    /// Target the app with this process id.
    #[arg(long)]
    pub pid: Option<u64>,
}

#[derive(Debug, Args)]
pub struct ComputerAppsArgs {
    /// Installed apps instead of running ones.
    #[arg(long)]
    pub installed: bool,
    /// Keep apps whose name or bundle id contains this text.
    #[arg(long)]
    pub query: Option<String>,
}

#[derive(Debug, Args)]
pub struct ComputerOpenArgs {
    /// App name, bundle id, or path.
    #[arg(value_name = "APP")]
    pub app: String,
    /// Start a second instance instead of re-activating a running one.
    #[arg(long)]
    pub new_instance: bool,
    /// Accepted for older scripts: an agent's app is never brought to the front.
    #[arg(long, hide = true)]
    pub no_activate: bool,
    /// How long to wait for its first window, in milliseconds.
    #[arg(long, value_name = "MS")]
    pub wait_ready: Option<u64>,
    /// Open this URL with the app.
    #[arg(long)]
    pub url: Option<String>,
    /// Open this file with the app.
    #[arg(long)]
    pub file: Option<String>,
}

#[derive(Debug, Args)]
pub struct ComputerFocusArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// A `win:` id from `computer windows`.
    #[arg(long)]
    pub window: Option<String>,
}

#[derive(Debug, Args)]
pub struct ComputerInspectArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// A `win:` id; defaults to the app's focused window.
    #[arg(long)]
    pub window: Option<String>,
    /// Keep elements whose label, value, or identifier contains this text.
    #[arg(long)]
    pub query: Option<String>,
    /// Keep elements with this role (`button`, `textField`, `link`, …).
    #[arg(long)]
    pub role: Option<String>,
    /// Stop descending past this depth.
    #[arg(long)]
    pub max_depth: Option<u64>,
    /// Visit at most this many nodes.
    #[arg(long)]
    pub max_nodes: Option<u64>,
    /// Also list elements scrolled out of view (they can still be pressed).
    #[arg(long)]
    pub include_offscreen: bool,
}

#[derive(Debug, Args)]
pub struct ComputerScreenshotArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// A `win:` id.
    #[arg(long)]
    pub window: Option<String>,
    /// A `display:` id; the main display when nothing else is named.
    #[arg(long)]
    pub display: Option<String>,
    /// A screen region as `x,y,w,h`.
    #[arg(long, value_name = "X,Y,W,H")]
    pub region: Option<String>,
    /// Write the image here.
    #[arg(long)]
    pub out: Option<String>,
    /// `png` (default) or `jpeg`.
    #[arg(long)]
    pub format: Option<String>,
    /// Downscale to at most this many pixels wide.
    #[arg(long)]
    pub max_width: Option<u64>,
    /// Include the image inline as base64.
    #[arg(long)]
    pub base64: bool,
}

#[derive(Debug, Args)]
pub struct ComputerClickArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// An element id from `inspect` (`s42:e12`).
    #[arg(long, conflicts_with_all = ["x", "image_x"])]
    pub element: Option<String>,
    /// Screen x.
    #[arg(long, requires = "y", allow_negative_numbers = true)]
    pub x: Option<f64>,
    /// Screen y.
    #[arg(long, requires = "x", allow_negative_numbers = true)]
    pub y: Option<f64>,
    /// x in a screenshot's pixels (needs `--screenshot`).
    #[arg(long, requires_all = ["image_y", "screenshot"])]
    pub image_x: Option<f64>,
    /// y in a screenshot's pixels (needs `--screenshot`).
    #[arg(long, requires_all = ["image_x", "screenshot"])]
    pub image_y: Option<f64>,
    /// The screenshot id `--image-x`/`--image-y` refer to.
    #[arg(long)]
    pub screenshot: Option<String>,
    /// `left` (default), `right`, or `middle`.
    #[arg(long)]
    pub button: Option<String>,
    /// Click this many times (2 for a double click).
    #[arg(long)]
    pub count: Option<u64>,
    /// Hold modifiers while clicking (`cmd`, `shift`, …).
    #[arg(long, value_delimiter = ',')]
    pub modifiers: Vec<String>,
    /// `auto` (default), `ax`, or `pointer`.
    #[arg(long)]
    pub method: Option<String>,
}

// Each flag is an independent switch on the command line; clap's derive maps
// them one to one, and grouping them into enums would only obscure `--help`.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Args)]
pub struct ComputerTypeArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// The text to type.
    #[arg(long, conflicts_with_all = ["text_stdin", "text_file"])]
    pub text: Option<String>,
    /// Read the text from stdin (any characters, newlines included).
    #[arg(long)]
    pub text_stdin: bool,
    /// Read the text from a file.
    #[arg(long)]
    pub text_file: Option<String>,
    /// An element id to type into; defaults to the focused field.
    #[arg(long)]
    pub element: Option<String>,
    /// Replace the field's contents instead of adding to them.
    #[arg(long)]
    pub replace: bool,
    /// The text is a secret: needed for password fields, never shown anywhere.
    #[arg(long)]
    pub secret: bool,
    /// `auto` (default), `ax`, or `keys`.
    #[arg(long)]
    pub method: Option<String>,
    /// Press Enter afterwards.
    #[arg(long)]
    pub submit: bool,
}

#[derive(Debug, Args)]
pub struct ComputerKeyArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// Chords to press in order: `mod+l`, `enter`, `shift+tab`, `cmd+,`.
    #[arg(value_name = "CHORD", required = true)]
    pub chords: Vec<String>,
    /// Press the whole sequence this many times.
    #[arg(long)]
    pub repeat: Option<u64>,
}

#[derive(Debug, Args)]
pub struct ComputerScrollArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// `up`, `down`, `left`, or `right`.
    #[arg(value_name = "DIRECTION")]
    pub direction: String,
    /// Lines to scroll (default 3).
    #[arg(long)]
    pub amount: Option<u64>,
    /// Scroll the element with this id.
    #[arg(long)]
    pub element: Option<String>,
    /// Screen x to scroll at.
    #[arg(long, requires = "y", allow_negative_numbers = true)]
    pub x: Option<f64>,
    /// Screen y to scroll at.
    #[arg(long, requires = "x", allow_negative_numbers = true)]
    pub y: Option<f64>,
}

#[derive(Debug, Args)]
pub struct ComputerMoveArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// Move to the element with this id.
    #[arg(long)]
    pub element: Option<String>,
    /// Screen x.
    #[arg(long, requires = "y", allow_negative_numbers = true)]
    pub x: Option<f64>,
    /// Screen y.
    #[arg(long, requires = "x", allow_negative_numbers = true)]
    pub y: Option<f64>,
    /// Point with the overlay cursor only; the real pointer stays put.
    #[arg(long)]
    pub visual_only: bool,
}

#[derive(Debug, Args)]
pub struct ComputerDragArgs {
    #[command(flatten)]
    pub target: ComputerAppArgs,
    /// Where to press: an element id or `x,y`.
    #[arg(long, allow_hyphen_values = true)]
    pub from: String,
    /// Where to release: an element id or `x,y`.
    #[arg(long, allow_hyphen_values = true)]
    pub to: String,
    /// How long the drag takes, in milliseconds.
    #[arg(long, value_name = "MS")]
    pub duration: Option<u64>,
    /// Hold modifiers while dragging.
    #[arg(long, value_delimiter = ',')]
    pub modifiers: Vec<String>,
}

#[derive(Debug, Args)]
pub struct ComputerStatusArgs {
    /// Read one durable task instead of the global activity snapshot.
    pub task_id: Option<String>,
    /// Wait until this task completes, fails, or needs input.
    #[arg(long, requires = "task_id")]
    pub wait: bool,
    /// Print the current state, then stream every activity event until Ctrl-C.
    #[arg(long)]
    pub events: bool,
}

/// Caller-supplied task variables. Secret values are never persisted by the host.
#[derive(Debug, Args)]
pub struct ComputerTaskInputs {
    /// Literal name=value pairs (repeatable).
    #[arg(long = "input")]
    pub inputs: Vec<String>,
    /// Secret name=value pairs (repeatable); prefer --inputs-json to avoid shell history.
    #[arg(long = "secret")]
    pub secrets: Vec<String>,
    /// JSON file with inputs and secrets maps, or - to read stdin.
    #[arg(long)]
    pub inputs_json: Option<String>,
    /// Maximum total steps, including those already performed.
    #[arg(long)]
    pub max_steps: Option<u64>,
    /// Return immediately; the host continues the task.
    #[arg(long)]
    pub detach: bool,
}

#[derive(Debug, Args)]
pub struct ComputerRunArgs {
    pub instruction: String,
    #[arg(long)]
    pub app: Option<String>,
    /// Reuse this id when retrying a request to avoid duplicate tasks.
    #[arg(long)]
    pub request_id: Option<String>,
    #[command(flatten)]
    pub inputs: ComputerTaskInputs,
}

#[derive(Debug, Args)]
pub struct ComputerResumeArgs {
    pub task_id: String,
    #[arg(long)]
    pub note: Option<String>,
    #[command(flatten)]
    pub inputs: ComputerTaskInputs,
}

#[derive(Debug, Args)]
pub struct ComputerPermissionsArgs {
    /// Show the OS permission prompts (or open System Settings).
    #[arg(long)]
    pub request: bool,
}

// -------------------------- whiteboard --------------------------

#[derive(Debug, Subcommand)]
pub enum WhiteboardCommand {
    /// Create a whiteboard from an Excalidraw scene JSON file or stdin.
    Create(WhiteboardCreateArgs),
    /// List every whiteboard in one worktree.
    List(WhiteboardListArgs),
    /// Search whiteboard titles and text elements in one worktree.
    Search(WhiteboardSearchArgs),
    /// Get one whiteboard, including its scene JSON.
    Get(WhiteboardIdArgs),
    /// Replace one whiteboard's title and scene.
    Edit(WhiteboardEditArgs),
    /// Delete one whiteboard. Requires confirmation unless `--yes` is passed.
    Delete(WhiteboardDeleteArgs),
    /// Render one whiteboard to a PNG file.
    View(WhiteboardViewArgs),
}

#[derive(Debug, Args)]
pub struct WhiteboardCreateArgs {
    /// Whiteboard title.
    #[arg(long)]
    pub title: Option<String>,
    /// Excalidraw scene JSON file, or `-` for stdin.
    #[arg(value_name = "SCENE|-", default_value = "-")]
    pub scene: String,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardListArgs {
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardSearchArgs {
    /// Case-insensitive query matched against title and text elements.
    pub query: String,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardIdArgs {
    /// Durable whiteboard id.
    pub id: String,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardEditArgs {
    /// Durable whiteboard id.
    pub id: String,
    /// Replacement whiteboard title.
    #[arg(long)]
    pub title: String,
    /// Replacement Excalidraw scene JSON file, or `-` for stdin.
    #[arg(value_name = "SCENE|-", default_value = "-")]
    pub scene: String,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardDeleteArgs {
    /// Durable whiteboard id.
    pub id: String,
    /// Skip interactive confirmation. Required for non-interactive use.
    #[arg(long)]
    pub yes: bool,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

#[derive(Debug, Args)]
pub struct WhiteboardViewArgs {
    /// Durable whiteboard id.
    pub id: String,
    /// PNG output path.
    pub output: String,
    /// Worktree id. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
}

// -------------------------- fanout --------------------------

/// Fanout commands talk directly to `pragma-server`, never through the desktop
/// broker: a fanout runs the same whether the app is open or closed.
#[derive(Debug, Subcommand)]
pub enum FanoutCommand {
    /// Launch one prompt into two or more isolated attempts under one parent.
    Create(FanoutCreateArgs),
    /// Show a fanout's members, statuses, and raw worktree/tab ids.
    Show(FanoutShowArgs),
    /// Read one member's terminal output, or every member's.
    Read(FanoutReadArgs),
    /// Send a follow-up to one member or to all of them.
    Send(FanoutSendArgs),
    /// Relaunch one member's agent in its existing worktree.
    Retry(FanoutMemberArgs),
    /// Stop every attempt and release the parent. Checkouts are kept.
    Cancel(FanoutRefArgs),
    /// Merge one attempt into the parent and delete every attempt. Destructive.
    Pick(FanoutPickArgs),
}

#[derive(Debug, Args)]
pub struct FanoutCreateArgs {
    /// The shared prompt. Conflicts with `--prompt-file`.
    #[arg(value_name = "PROMPT")]
    pub prompt: Option<String>,
    /// Read the shared prompt from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-", conflicts_with = "prompt")]
    pub prompt_file: Option<String>,
    /// Existing parent worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID", conflicts_with = "new_parent")]
    pub parent: Option<String>,
    /// Create a coordination parent on this branch first.
    #[arg(long, value_name = "BRANCH")]
    pub new_parent: Option<String>,
    /// Display title for a newly created parent.
    #[arg(long, requires = "new_parent")]
    pub parent_title: Option<String>,
    /// Source worktree a new parent branches from. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID", requires = "new_parent")]
    pub from: Option<String>,
    /// One attempt, as `agent[.model[.reasoning]]`. Repeat for each attempt
    /// (at least two). Duplicates are allowed — sampling one model twice is a
    /// supported use.
    #[arg(long = "agent", value_name = "SELECTOR")]
    pub agents: Vec<String>,
    /// Reasoning effort for every attempt that does not name its own.
    #[arg(long, value_name = "ID")]
    pub reasoning: Option<String>,
    /// Bound on concurrently launching attempts.
    #[arg(long, value_name = "N")]
    pub jobs: Option<u32>,
    /// Repeating a create with the same key returns the existing fanout
    /// instead of provisioning a second one.
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

/// Addresses a fanout: by id, or by the current worktree. Every fanout command
/// accepts the same pair.
#[derive(Debug, Args)]
pub struct FanoutRefArgs {
    /// Fanout id. Defaults to `$PRAGMA_FANOUT_ID`, then to the fanout owning
    /// `$PRAGMA_WORKTREE_ID` (as a parent or as an attempt).
    #[arg(value_name = "FANOUT_ID")]
    pub fanout: Option<String>,
}

#[derive(Debug, Args)]
pub struct FanoutShowArgs {
    #[command(flatten)]
    pub reference: FanoutRefArgs,
    /// Print the current state, then stream every update until Ctrl-C.
    #[arg(long)]
    pub watch: bool,
}

#[derive(Debug, Args)]
pub struct FanoutReadArgs {
    #[command(flatten)]
    pub reference: FanoutRefArgs,
    /// Member to read. Defaults to `$PRAGMA_FANOUT_MEMBER_ID`.
    #[arg(long, value_name = "ID", conflicts_with = "all")]
    pub member: Option<String>,
    /// Read every member.
    #[arg(long)]
    pub all: bool,
    /// Tail the last N lines of each target.
    #[arg(long, default_value_t = 200)]
    pub lines: u32,
}

#[derive(Debug, Args)]
pub struct FanoutSendArgs {
    #[command(flatten)]
    pub reference: FanoutRefArgs,
    /// Member to send to.
    #[arg(long, value_name = "ID", conflicts_with = "all")]
    pub member: Option<String>,
    /// Send to every member.
    #[arg(long)]
    pub all: bool,
    /// The follow-up text. Conflicts with `--message-file`.
    #[arg(long)]
    pub message: Option<String>,
    /// Read the follow-up from a file, or `-` for stdin.
    #[arg(long, value_name = "PATH|-", conflicts_with = "message")]
    pub message_file: Option<String>,
    /// Reuse a message id so a retry cannot deliver the same follow-up twice.
    #[arg(long, value_name = "ID")]
    pub message_id: Option<String>,
    /// Return as soon as the message is enqueued instead of waiting for
    /// per-member delivery receipts.
    #[arg(long)]
    pub no_wait: bool,
}

#[derive(Debug, Args)]
pub struct FanoutMemberArgs {
    #[command(flatten)]
    pub reference: FanoutRefArgs,
    /// Member to act on. Defaults to `$PRAGMA_FANOUT_MEMBER_ID`.
    #[arg(long, value_name = "ID")]
    pub member: Option<String>,
}

#[derive(Debug, Args)]
pub struct FanoutPickArgs {
    #[command(flatten)]
    pub member: FanoutMemberArgs,
    /// Skip the interactive confirmation. Required for automation.
    #[arg(long)]
    pub yes: bool,
}

// -------------------------- scratchpad --------------------------

#[derive(Debug, Subcommand)]
pub enum ScratchpadCommand {
    /// Create and open a managed scratchpad attached to the current agent tab.
    Create(ScratchpadCreateArgs),
}

#[derive(Debug, Args)]
pub struct ScratchpadCreateArgs {
    /// Scratchpad title shown in Pragma.
    #[arg(long)]
    pub title: String,
    /// Source MDX file, or `-` to read MDX from stdin.
    #[arg(value_name = "MDX_FILE|-", value_hint = clap::ValueHint::FilePath)]
    pub file: String,
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
    /// Start an agent in a new terminal tab, optionally with a model, mode,
    /// permission mode, and slash command. Goes through the gateway, so it
    /// works with the app closed when the worktree is known to the host.
    Start(AgentStartArgs),
    /// List an agent's models, modes, permission modes, and slash commands.
    Options(AgentOptionsArgs),
    /// Print one row per agent with its tabId. Direct to the server (works with
    /// the app closed). `--watch` keeps the subscription open and prints deltas.
    Status(AgentStatusArgs),
    /// Report an external agent's status to the server. Direct to the server;
    /// the reporting logic is the same as before, only the command path moved.
    Report(AgentReportArgs),
    /// Supervise one prepared agent invocation, reporting its start and end to
    /// the host. Written into a tracked launch by
    /// `pragma-cli agent run --run-id <id> -- <argv…>`; not meant to be run by
    /// hand.
    Run(AgentRunArgs),
    /// Report a rich agent message to the server. Direct to the server.
    Message(AgentMessageArgs),
    /// Block until a command-approval verdict arrives for `--request-id`, then
    /// print `allow`/`deny` on stdout. A blocking harness hook calls this after a
    /// `report attention --kind command`; on timeout it exits non-zero with no
    /// output so the caller can fall back to its native prompt.
    AwaitDecision(AgentAwaitDecisionArgs),
    /// Publish a command-approval verdict for `--request-id`, fanned out to the
    /// waiting reporter. The controlling-client side of `await-decision`.
    Decide(AgentDecideArgs),
    /// Publish a reply to a `question` attention request for `--request-id`,
    /// fanned out to the waiting reporter. The controlling-client side of
    /// `await-answer`.
    Answer(AgentAnswerPublishArgs),
    /// Block until a question reply arrives for `--request-id`, then print the
    /// answer text on stdout. A blocking harness hook calls this after a `report
    /// attention --kind question`; on timeout it exits non-zero with no output
    /// so the caller can fall back to its native prompt.
    AwaitAnswer(AgentAwaitAnswerArgs),
    /// Publish a free-form interjection for a running agent, fanned out to the
    /// waiting reporter (a harness input hook or a plugin watcher) which
    /// delivers the text into the agent's turn. The controlling-client side of
    /// an interject.
    Input(AgentInputArgs),
    /// Launch the real agent and verify its integration through the gateway API.
    Verify(AgentVerifyArgs),
}

#[derive(Debug, Args)]
pub struct AgentVerifyArgs {
    /// Agent id from the plugin catalog (unqualified built-in ids are accepted).
    #[arg(long)]
    pub agent: String,
    /// Abort emulation bytes. Supports `\e`, `\xNN`, `\r`, `\n`, and `\t`.
    #[arg(long = "abort-input", default_value = "\\x1b")]
    pub abort_input: String,
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Model id. Defaults to the first catalog model.
    #[arg(long, conflicts_with = "pick_model_cmd")]
    pub model: Option<String>,
    /// Raw model command appended to the agent's base launch command instead of
    /// a catalog model (for example `--pick-model-cmd "--model moonshot/kimi-k3"`).
    /// Use it to verify against models the catalog does not list, such as the
    /// cheapest subagent-capable model, to save tokens.
    #[arg(
        long = "pick-model-cmd",
        value_name = "ARGS",
        allow_hyphen_values = true
    )]
    pub pick_model_cmd: Option<String>,
    /// Run only this scenario. Repeat to select several.
    #[arg(long = "scenario", value_name = "ID")]
    pub scenarios: Vec<String>,
    /// Stop after the first failed scenario.
    #[arg(long)]
    pub fail_fast: bool,
    /// Fresh-session attempts per scenario.
    #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u32).range(1..))]
    pub attempts: u32,
    /// Per-step timeout in seconds.
    #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(1..))]
    pub step_timeout: u64,
    /// Include slow/advisory timeout scenarios.
    #[arg(long)]
    pub include_slow: bool,
    /// JSON file mapping scenario ids to prompt overrides.
    #[arg(long, value_name = "FILE")]
    pub prompts: Option<String>,
    /// Concurrent scenario sessions. `stream-integrity` always runs alone after
    /// parallel scenarios settle.
    #[arg(long, default_value_t = 6, value_parser = clap::value_parser!(u16).range(1..=16))]
    pub jobs: u16,
    /// Launch scenario sessions through the connected desktop app (opens a
    /// visible tab per launch). Default launches headlessly on the host server.
    #[arg(long)]
    pub headed: bool,
}

#[derive(Debug, Args)]
pub struct AgentStartArgs {
    /// Target worktree. Defaults to `$PRAGMA_WORKTREE_ID`.
    #[arg(long, value_name = "ID")]
    pub worktree: Option<String>,
    /// Agent id from the plugin catalog (unqualified built-in ids are accepted).
    #[arg(long)]
    pub agent: String,
    /// Model id to launch with (optional).
    #[arg(long)]
    pub model: Option<String>,
    /// Reasoning effort for `--model` (optional).
    #[arg(long, value_name = "ID", requires = "model")]
    pub reasoning: Option<String>,
    /// Agent mode / primary agent to start in. Defaults to the agent's first mode.
    #[arg(long, value_name = "ID")]
    pub mode: Option<String>,
    /// Permission mode to start in. Defaults to the agent's first permission mode.
    #[arg(long, value_name = "ID")]
    pub permission_mode: Option<String>,
    /// Slash command (without the `/`) to run; `--prompt` becomes its input.
    #[arg(long, value_name = "NAME")]
    pub slash_command: Option<String>,
    /// Prompt prefill to send once the agent is ready (optional).
    #[arg(long)]
    pub prompt: Option<String>,
    /// Launch on the host server without opening a desktop tab.
    #[arg(long)]
    pub headless: bool,
}

#[derive(Debug, Args)]
pub struct AgentOptionsArgs {
    /// Agent id from the plugin catalog (unqualified built-in ids are accepted).
    #[arg(long)]
    pub agent: String,
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
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    #[command(subcommand)]
    pub report: AgentReportCommand,
}

#[derive(Debug, Args)]
pub struct AgentRunArgs {
    /// The run id the host prepared this invocation under.
    #[arg(long = "run-id")]
    pub run_id: String,
    /// The literal argv to supervise, after the `--` separator. Runs in this
    /// same terminal with `PRAGMA_AGENT_RUN_ID` in its environment.
    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    pub command: Vec<String>,
}

#[derive(Debug, Args)]
pub struct AgentAwaitDecisionArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// The requestId this call waits on; must match the one sent with
    /// `report attention --kind command --request-id`.
    #[arg(long = "request-id")]
    pub request_id: String,
    /// Seconds to wait before giving up. `0` waits indefinitely.
    #[arg(long, default_value_t = 300)]
    pub timeout: u64,
}

#[derive(Debug, Args)]
pub struct AgentDecideArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// The requestId this verdict answers; must match the one sent with
    /// `report attention --kind command --request-id`.
    #[arg(long = "request-id")]
    pub request_id: String,
    /// Approve the command.
    #[arg(long, conflicts_with = "deny")]
    pub allow: bool,
    /// Reject the command.
    #[arg(long)]
    pub deny: bool,
}

#[derive(Debug, Args)]
pub struct AgentAnswerPublishArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// The requestId this reply answers; must match the one sent with
    /// `report attention --kind question --request-id`.
    #[arg(long = "request-id")]
    pub request_id: String,
    /// The reply text. Mutually exclusive with `--dismiss`.
    #[arg(long, conflicts_with = "dismiss")]
    pub text: Option<String>,
    /// Dismiss the question without answering.
    #[arg(long)]
    pub dismiss: bool,
}

#[derive(Debug, Args)]
pub struct AgentAwaitAnswerArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// The requestId this call waits on; must match the one sent with
    /// `report attention --kind question --request-id`.
    #[arg(long = "request-id")]
    pub request_id: String,
    /// Seconds to wait before giving up. `0` waits indefinitely.
    #[arg(long, default_value_t = 300)]
    pub timeout: u64,
    /// Print this value and exit successfully when the question is dismissed.
    /// Without this option, dismissal exits non-zero with no output.
    #[arg(long = "dismiss-output")]
    pub dismiss_output: Option<String>,
}

#[derive(Debug, Args)]
pub struct AgentInputArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// The interjection text to deliver to the running agent.
    #[arg(long)]
    pub text: String,
    /// Optional correlation id when the interjection answers a specific prompt.
    #[arg(long = "request-id")]
    pub request_id: Option<String>,
}

#[derive(Debug, Args)]
pub struct AgentMessageArgs {
    /// Stable agent id from the plugin agent definition.
    #[arg(long)]
    pub agent: String,
    /// `AgentMessage` JSON payload. Routing keys are filled from env/--agent.
    #[arg(long, conflicts_with = "stdin")]
    pub payload: Option<String>,
    /// Read `AgentMessage` JSON payload from stdin. Routing keys are filled from env/--agent.
    #[arg(long)]
    pub stdin: bool,
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
        /// The command text awaiting approval. Shown in the approval toast so a
        /// non-terminal client can review it. Pair with `--kind command`.
        #[arg(long)]
        command: Option<String>,
        /// The question text awaiting an answer. Shown in the toast so a
        /// non-terminal client can review it. Pair with `--kind question`.
        #[arg(long)]
        question: Option<String>,
        /// Answer choices for a `question` attention, as a JSON array of
        /// `{"label": "...", "description": "..."}` objects (`description`
        /// optional). Pair with `--kind question`; omit for free-text.
        #[arg(long)]
        options: Option<String>,
        /// Multiple questions for a `question` attention, as a JSON array of
        /// `{"question": "...", "options": [...]}` objects. When present,
        /// clients render a back/next wizard and submit every answer together;
        /// the legacy `--question`/`--options` fields still cover a single
        /// question.
        #[arg(long)]
        questions: Option<String>,
        /// Correlation id for the command-approval or question round-trip. Set
        /// this and then call `agent await-decision`/`await-answer
        /// --request-id <id>` to block for the verdict/reply.
        #[arg(long = "request-id")]
        request_id: Option<String>,
    },
    /// Reports the human-readable name of the agent's active session without
    /// changing the agent's status. Pragma renames the hosting tab (unless the
    /// user renamed it manually). Report again on every rename or session switch.
    #[command(name = "session-name")]
    SessionName {
        /// The session's display name.
        #[arg(long)]
        name: String,
    },
    /// Reports the harness's own session id (the opaque conversation id a
    /// resume continues) without changing the agent's status, or clears it.
    /// Report again whenever the harness switches conversations, so a restore
    /// resumes the latest one; clear it when there is no conversation to
    /// resume (a new, not-yet-materialized session, or the selected one was
    /// deleted).
    #[command(name = "session-id")]
    SessionId {
        /// The harness's conversation id, verbatim. Mutually exclusive with
        /// `--clear`; one of the two is required.
        #[arg(long, conflicts_with = "clear", required_unless_present = "clear")]
        id: Option<String>,
        /// Clear the stored conversation id instead of setting one, so nothing
        /// auto-resumes it. A later launch starts a fresh conversation.
        #[arg(long, required_unless_present = "id")]
        clear: bool,
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
    fn scratchpad_create_parses_title_and_mdx_file() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "scratchpad",
            "create",
            "--title",
            "Architecture",
            "result.mdx",
        ])
        .expect("scratchpad create parses");
        let TopCommand::Scratchpad {
            scratchpad: ScratchpadCommand::Create(args),
        } = cli.command
        else {
            panic!("expected scratchpad create");
        };
        assert_eq!(args.title, "Architecture");
        assert_eq!(args.file, "result.mdx");
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
    fn agent_run_parses_the_run_id_and_literal_argv() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "run",
            "--run-id",
            "run-1",
            "--",
            "claude",
            "--resume",
            "abc",
        ])
        .expect("agent run parses");
        let TopCommand::Agent {
            agent: AgentCommand::Run(args),
        } = cli.command
        else {
            panic!("expected agent run");
        };
        assert_eq!(args.run_id, "run-1");
        assert_eq!(args.command, ["claude", "--resume", "abc"]);
    }

    #[test]
    fn agent_report_session_id_parses_an_id_or_a_clear() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "claude-code",
            "session-id",
            "--id",
            "session-abc",
        ])
        .expect("session-id report parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(args),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        let AgentReportCommand::SessionId { id, clear } = args.report else {
            panic!("expected session-id");
        };
        assert_eq!(id.as_deref(), Some("session-abc"));
        assert!(!clear);

        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "pi",
            "session-id",
            "--clear",
        ])
        .expect("session-id --clear parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(args),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        let AgentReportCommand::SessionId { id, clear } = args.report else {
            panic!("expected session-id");
        };
        assert!(id.is_none());
        assert!(clear);
    }

    #[test]
    fn agent_report_session_id_requires_exactly_one_of_id_or_clear() {
        assert!(Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "pi",
            "session-id",
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "pi",
            "session-id",
            "--id",
            "session-abc",
            "--clear",
        ])
        .is_err());
    }

    #[test]
    fn agent_input_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "input",
            "--agent",
            "opencode",
            "--text",
            "focus on the tests",
        ])
        .expect("agent input parses");
        let TopCommand::Agent {
            agent: AgentCommand::Input(args),
        } = cli.command
        else {
            panic!("expected agent input");
        };
        assert_eq!(args.agent, "opencode");
        assert_eq!(args.text, "focus on the tests");
        assert_eq!(args.request_id, None);
    }

    #[test]
    fn agent_verify_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "verify",
            "--agent",
            "opencode",
            "--scenario",
            "basic-reply",
            "--attempts",
            "3",
            "--jobs",
            "16",
            "--pick-model-cmd",
            "--model moonshot/kimi-k3",
        ])
        .expect("agent verify parses");
        let TopCommand::Agent {
            agent: AgentCommand::Verify(args),
        } = cli.command
        else {
            panic!("expected agent verify");
        };
        assert_eq!(args.agent, "opencode");
        assert_eq!(args.scenarios, ["basic-reply"]);
        assert_eq!(args.attempts, 3);
        assert_eq!(args.jobs, 16);
        assert_eq!(args.abort_input, "\\x1b");
        assert_eq!(
            args.pick_model_cmd.as_deref(),
            Some("--model moonshot/kimi-k3")
        );
        assert_eq!(args.model, None);
    }

    #[test]
    fn agent_verify_rejects_model_with_pick_model_cmd() {
        let result = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "verify",
            "--agent",
            "opencode",
            "--model",
            "gpt-5",
            "--pick-model-cmd",
            "--model moonshot/kimi-k3",
        ]);
        assert!(result.is_err());
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
                kind: Some(AttentionKindArg::Question),
                ..
            }
        ));
    }

    #[test]
    fn agent_report_attention_with_question_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "report",
            "--agent",
            "mock",
            "attention",
            "--kind",
            "question",
            "--question",
            "Which option?",
            "--request-id",
            "req-9",
        ])
        .expect("attention with question parses");
        let TopCommand::Agent {
            agent: AgentCommand::Report(AgentReportArgs { report, .. }),
        } = cli.command
        else {
            panic!("expected agent report");
        };
        let AgentReportCommand::Attention {
            question,
            request_id,
            ..
        } = report
        else {
            panic!("expected attention");
        };
        assert_eq!(question.as_deref(), Some("Which option?"));
        assert_eq!(request_id.as_deref(), Some("req-9"));
    }

    #[test]
    fn agent_decide_allow_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "decide",
            "--agent",
            "mock",
            "--request-id",
            "req-1",
            "--allow",
        ])
        .expect("agent decide --allow parses");
        let TopCommand::Agent {
            agent: AgentCommand::Decide(args),
        } = cli.command
        else {
            panic!("expected agent decide");
        };
        assert!(args.allow);
        assert!(!args.deny);
        assert_eq!(args.request_id, "req-1");
    }

    #[test]
    fn agent_decide_allow_and_deny_conflict() {
        let result = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "decide",
            "--agent",
            "mock",
            "--request-id",
            "req-1",
            "--allow",
            "--deny",
        ]);
        assert!(
            result.is_err(),
            "--allow and --deny must not parse together"
        );
    }

    #[test]
    fn agent_answer_text_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "answer",
            "--agent",
            "mock",
            "--request-id",
            "req-2",
            "--text",
            "option B",
        ])
        .expect("agent answer --text parses");
        let TopCommand::Agent {
            agent: AgentCommand::Answer(args),
        } = cli.command
        else {
            panic!("expected agent answer");
        };
        assert_eq!(args.text.as_deref(), Some("option B"));
        assert!(!args.dismiss);
    }

    #[test]
    fn agent_answer_text_and_dismiss_conflict() {
        let result = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "answer",
            "--agent",
            "mock",
            "--request-id",
            "req-2",
            "--text",
            "x",
            "--dismiss",
        ]);
        assert!(
            result.is_err(),
            "--text and --dismiss must not parse together"
        );
    }

    #[test]
    fn agent_await_answer_parses() {
        let cli = Cli::try_parse_from([
            "pragma-cli",
            "agent",
            "await-answer",
            "--agent",
            "mock",
            "--request-id",
            "req-3",
        ])
        .expect("agent await-answer parses");
        let TopCommand::Agent {
            agent: AgentCommand::AwaitAnswer(args),
        } = cli.command
        else {
            panic!("expected agent await-answer");
        };
        assert_eq!(args.request_id, "req-3");
        assert_eq!(args.timeout, 300);
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
            AgentReportCommand::Attention { kind: None, .. }
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
    fn global_toon_flag_parses_and_resolves_format() {
        let cli = Cli::try_parse_from(["pragma-cli", "--toon", "agent", "status"])
            .expect("--toon before group works");
        assert!(cli.toon);
        assert_eq!(cli.format(), crate::output::Format::Toon);
        let cli = Cli::try_parse_from(["pragma-cli", "agent", "--toon", "status"])
            .expect("--toon after group works");
        assert!(cli.toon);
    }

    #[test]
    fn json_and_toon_are_mutually_exclusive() {
        let result = Cli::try_parse_from(["pragma-cli", "--json", "--toon", "agent", "status"]);
        assert!(result.is_err(), "--json and --toon together must not parse");
    }

    #[test]
    fn default_format_is_text() {
        let cli = Cli::try_parse_from(["pragma-cli", "agent", "status"])
            .expect("plain invocation parses");
        assert_eq!(cli.format(), crate::output::Format::Text);
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
