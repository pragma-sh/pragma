# apps/pragma — Tauri Desktop App

The Pragma desktop app: React frontend + Rust (Tauri) backend. It is being shrunk into
a thin native client: presentation, native windows/menus/deep links, and client-side
PTY channel forwarding live here; host-owned state moves behind `pragma-server`.

## File map

```
apps/pragma/
├── src/                         # React frontend (TypeScript)
│   ├── components/              # Workspace shell, sidebar, tab strip, dialogs, terminal host
│   ├── components/ui/           # shadcn/ui primitives (generated; avoid hand-edits)
│   ├── lib/
│   │   ├── tauri.ts             # Typed bridge to Rust — the ONLY place invoke() is called
│   │   ├── github.ts            # GitHub client — the ONLY place new Octokit() happens
│   │   ├── terminal-manager.ts  # Non-React xterm registry; output bypasses React state
│   │   ├── native-editing.ts    # OS text-editing chords → readline sequences
│   │   ├── agent-alert.ts       # Alert latch (chime + notification, fires at most once)
│   │   ├── native-overlay.ts    # Ref-counted suppression store for native webview overlays
│   │   ├── brand-icons.ts/json  # Curated offline icon subset (lucide + simple-icons)
│   │   ├── file-icons.ts        # vscode-icons rendered offline via @iconify/react
│   │   └── utils.ts             # cn() + small utilities
│   ├── hooks/                   # use-shortcuts (keybindings), use-escape-to-close
│   ├── components/kanban/       # Project prompt board (ProjectKanbanWorkspace, cards, draft/completion modals)
│   ├── state/
│   │   ├── workspace-context.tsx   # Projects / worktrees / tabs reducer + context
│   │   ├── kanban-context.tsx      # Project prompt board: cards, shell-mode switch, background launch, completion
│   │   ├── github-context.tsx      # GitHub auth state (useGitHub)
│   │   ├── agent-status-store.ts   # Runtime agent dots (useSyncExternalStore)
│   │   ├── agent-pins.ts           # Cosmetic localStorage agent pins
│   │   ├── right-sidebar-context.tsx
│   │   ├── editor-dirty-store.ts   # Ephemeral editor dirty state (never in reducer)
│   │   ├── review-done-store.ts    # Ephemeral per-file PR review done-toggle
│   │   ├── review-focus-store.ts   # Ephemeral "scroll this review file into view" request
│   │   └── fix-it-store.ts         # Ephemeral per-PR "fix it list" of flagged review comments
│   ├── App.tsx
│   └── main.tsx
└── src-tauri/                   # Rust backend
    ├── src/lib.rs               # App wiring, managed state, plugins, command registration
    ├── src/db.rs                # SQLite migrations + typed CRUD (v8 = kanban_cards)
    ├── src/kanban.rs            # Tauri commands for the prompt Kanban board (CRUD + move)
    ├── src/pty.rs               # Thin pragma-client adapter + PTY channel forwarding
    ├── src/git.rs               # Git CLI helpers
    ├── src/github.rs            # GitHub auth (0600 token file, OAuth device flow, gh CLI)
    ├── src/fs.rs                # Worktree-scoped, path-safe filesystem commands
    ├── src/main.rs              # Thin entrypoint
    ├── tauri.conf.json          # Window/bundle config; bundles server via externalBin
    ├── tauri.dev.conf.json      # Dev overrides ("Pragma Dev" + icons-dev/)
    ├── scripts/stage-daemon-sidecar.sh  # Builds + stages server, pragma-cli, sidecars, bundled agent configs
    ├── binaries/                # Staged sidecars (git-ignored; built, never committed)
    ├── resources/pragma/agents/ # Staged bundled agent configs (git-ignored)
    ├── icons/                   # Production app icons
    └── icons-dev/               # Dev icons
```

## Adding a Tauri command (frontend ⇄ backend)

1. **Rust** (`src-tauri/src/lib.rs`): write `#[tauri::command] fn my_command(...) -> T`
   and register it in `tauri::generate_handler![...]`. Prefer payload/return types from
   `@pragma/constants` so the contract is shared.
2. **TS** (`src/lib/tauri.ts`): add a typed wrapper
   `export function myCommand(...): Promise<T> { return invoke<T>("my_command", ...) }`.
3. **Components** import the wrapper — never call `invoke()` directly.
4. Add a Vitest that mocks `@tauri-apps/api/core` and a `cargo test` for the Rust logic.

## UI: Tailwind v4 + shadcn/ui

- Add primitives with `bunx shadcn@latest add <component>` (writes to
  `src/components/ui/`). Don't hand-roll what shadcn provides.
- Compose primitives into feature components elsewhere in `src/`; keep `components/ui`
  for unmodified primitives.
- Use the `cn()` helper (`src/lib/utils.ts`) for conditional classes. Theme tokens live
  in `src/index.css` (`@theme`/CSS variables) — use semantic tokens (`bg-background`,
  `text-muted-foreground`), not raw colors.

## GitHub integration

`apps/pragma/src/lib/github.ts` is the **only** place `new Octokit()` happens — the
same discipline as the `invoke()` rule. Components import typed helpers
(`findPullRequestForBranch`, `createPullRequest`, `getChecksStatus`,
`listReviewThreads`/`resolveReviewThread`/`unresolveReviewThread`, …); they never build
a client. The client is lazily built from the stored token (`githubToken()`) and cached
by token, so sign-in/out rebuilds it (`resetGitHubClient`).

Everything **secret/OS/git** stays in Rust (`src-tauri/src/github.rs`): the token is
stored in a **`0600` plaintext file** (`github-token`, owned by `TokenStore`) — the
same model the `gh` CLI uses, and **never SQLite**. The OS keychain is deliberately
**not** used: keychain items are scoped to the app's code signature, so unsigned dev
builds re-prompt on every launch. The plaintext file has no signature check.

Also in Rust: OAuth **Device Flow** polling (`reqwest` blocking, no client
secret/PKCE), `gh` CLI detection/adoption, `origin`→`owner/repo`, fetch+ahead/behind,
push, the local `base...HEAD` PR file diff, and remote-branch delete. Worktree-scoped
GitHub git operations must run through the owning host's `git` RPC so remote project
paths are evaluated on the remote host, not the desktop client. The
`oauthClientId`, scopes, and endpoint URLs are in `@pragma/constants` (`github` block);
the setup-skip flag persists in the `settings` table (`github.setupDismissed`).

Auth state is held by `state/github-context.tsx` (`useGitHub`) and gates both the
full-screen `GitHubSetupModal` and the **Pull Request** right-sidebar subtab. The PR
subtab (`right-sidebar/PullRequestTab`) resolves logged-out → create
(`CreatePullRequestView`, TipTap markdown editor) → view (`ViewPullRequestView`). A PR
review opens a `pr-review` `TabKind` (v7 `pr_number` column) rendered through
`SplitHost` (`github/ReviewTab`): per-file done-toggle (ephemeral
`state/review-done-store.ts`), side-by-side diff via the shared `editor/MergeDiff`
(fed by `github_pr_file_diff`), and inline thread resolve/unresolve.

Each `ReviewThreadCard` also offers two fix affordances: **Fix** (opens
`github/FixCommentDialog` to launch an agent on that one comment) and **Add to fix it
list** (flags it into the ephemeral `state/fix-it-store.ts`); the tab header's **Address
fix it list** button opens `github/FixItListDialog` to fix the whole batch at once. Both
dialogs share `hooks/use-fix-launcher.ts` (agent pick via `hooks/use-agent-selection.ts`,
an optional new-worktree to fix on, then `startSession`) and build prompts with
`lib/fix-it-prompt.ts`.

The resolve/unresolve toggle is **optimistic**: `ReviewThreadCard` flips the thread in
place and fires the GraphQL mutation in the background, reverting + toasting **only on
failure** — it never refetches the whole tab. `MergeDiff` gives both panes a
**line-number gutter** and **syntax highlighting** (custom dark `pragmaHighlightStyle`
in `editor/codemirror-theme.ts`; grammar detected from filename via
`@codemirror/language-data` into a `Compartment`). It takes optional
`comments: DiffComment[]` and mounts each as a block widget via React portal. Markdown
is rendered read-only via `react-markdown` + `remark-gfm` (`github/GitHubMarkdown`).
The `simple-icons:github` glyph is bundled offline through `brand-icons.json`.

## Agent connector (frontend side)

The frontend stores runtime agent status in `state/agent-status-store.ts` via
`useSyncExternalStore`. Status dots: `done` = green, `running` = yellow, `attention` =
red, precedence **red > yellow > green** when aggregating a tab's agents or a
worktree's tabs. Green is a "finished, go look" notification.

The Rust event bridge subscribes once per connected host (`agent_events::start_for`):
the local managed server at startup, and each SSH remote when it registers or
agent-auth reconnects. All hosts emit the same `pragma:agent-report` /
`pragma:agent-status-reset` Tauri event names so the frontend store is host-agnostic.

`running`/`attention` persist through a focus; viewing a tab clears its `done` entries
from the store (`clearDoneStatusForTab`) **and tells the daemon to drop the stored
`done`** (`markAgentsSeen`, `MarkAgentsSeen` request) — both when the tab becomes
on-screen and when a `done` report arrives for an already-visible tab. Closing a tab
drops all its status (`removeAgentStatusForTab`).

**Alerts (chime + system notification) are gated by a latch separate from the dot
store.** `lib/agent-alert.ts` keeps an `alertedStatusByKey` latch keyed by
worktree+tab+agent: a `done`/`attention` alerts at most once
(`shouldAlertForStatus` + `latchAlertedStatus`), released only when the agent genuinely
moves on (a `running` or `cleared` report, `releaseAlertLatch`), and dropped on tab
close (`releaseAlertLatchForTab`). A snapshot replay restores the dots without
re-notifying. **Viewing a tab latches every `done`/`attention` status it currently
shows as seen** — the `visibleTabIds` effect reads `agentStatusesForTab` and latches
them before `clearDoneStatusForTab` when a tab comes on screen.

macOS agent system notifications are clickable: the frontend calls the macOS-only
`show_agent_notification` Tauri command instead of the generic notification plugin, and
Rust emits `pragma:agent-notification-clicked` with `{ projectId, worktreeId, tabId }`;
`workspace-context` routes that through `navigateToAgentLocation`. Non-macOS falls back
to the regular plugin notification.

Agent launcher configs live in `~/.pragma/agents/<id>/config.json` with fields `id`,
`name`, `icon`, `start`, optional `models`, optional `prefillDelayMs`, optional
`startupInput` (`[{ delayMs, data }]`, sent after `start` and before the prompt prefill),
and optional prefill controls (`prefillMode: "bracketed" | "plain"`, `prefillSubmit`,
`prefillSubmitDelayMs`). The prompt body and its submit key are always sent as two
separate PTY writes (`prefillSubmitDelayMs` apart, default 200ms) so a paste-aware TUI
commits the text before the submit keypress lands — this is why Kanban background launches
and foreground launches both submit reliably across agents. Use these only for generic
pre-TUI gates / input semantics owned by that agent config; core must not hard-code
per-agent keystrokes. Bundled configs live in
`apps/pragma/src-tauri/resources/pragma/agents/` (staged by
`scripts/stage-daemon-sidecar.sh`) and are installed/updated into `~/.pragma/agents`
on app startup. `pragma-cli` is installed/updated to `~/.local/bin` on startup; daemon
terminal sessions export `PRAGMA_CLI=$HOME/.local/bin/pragma-cli` and prepend that
directory to `PATH` so bundled plugins can report status even when the user's shell
doesn't include it. The app still emits a UI warning if that directory is not on the
app's startup `$PATH`.

`models` may be `static` or `command` backed. Pragma resolves model lists lazily when the
selector submenu is hovered/focused, caches the last result, executes command-backed
discovery with cwd set to the installed agent directory, and validates only the generic
JSON array (`[{ id, name, reasoning? }]`). Host-specific CLI parsing belongs in
plugin-owned scripts under `pragma/agents/<id>/scripts/`; core must not learn Cursor,
opencode, or other host output formats. There is no provider-level Auto model; when a
model has reasoning entries, the model-only choice is shown as Auto reasoning. Model
commands run through `process_env::command`, which extends GUI-launched packaged apps'
minimal `$PATH` with common user/tool bins such as `~/.opencode/bin`, version-manager
shims, Homebrew, and macOS Python.framework.

Agent pins are cosmetic localStorage state in `state/agent-pins.ts`.

## Server sidecar + instance channel

See `crates/pragma-server/AGENTS.md` and `crates/pragma-client/AGENTS.md` for the
server/client internals. App-side notes:

**The server ships as a Tauri sidecar.** A release app launches it from beside its own
executable (`pragma-client::sidecar_executable("pragma-server")`); a debug app spawns it via
`cargo run -p pragma-server`. The sidecar is staged by
`scripts/stage-daemon-sidecar.sh` (`cargo build -p pragma-server` + copy with host
triple), wired in three places: `tauri:build`'s `beforeBuildCommand` runs it
`--release`, `tauri:dev` runs it (debug) before `tauri dev`, and the pre-push hook
runs it before `cargo check` because Tauri validates `externalBin` paths during
compilation. The server is spawned directly with `std::process::Command`, **not** the
shell plugin. `pragma-cli`, `pragma-ai`, `pragma-github`, and the bundled agent launcher
configs (`resources/pragma/agents/`) are staged by the same script; plugin JS itself is
**not** bundled by Pragma. `binaries/` is git-ignored.

**Dev, prod, and every dev worktree are fully isolated by an instance "channel".**
`instance_channel` in `src-tauri/src/pty.rs` returns `pragma` for a production build
("Pragma") and `pragma-dev-<hash>` for a dev build ("Pragma Dev") where `<hash>` is
`pragma_protocol::dev_channel(workspace_root)` — a deterministic hash of the absolute
workspace root. Two worktree checkouts → different channels; same worktree → stable
across rebuilds. Product identity (not `cfg!(debug_assertions)`) is deliberate so a
release-built dev app keeps its own per-worktree instance.

- **Data dir:** `instance_data_dir` returns the legacy app-data root verbatim for prod
  (no relocation) and `app_data_dir/<channel>` for dev. `lib.rs` `setup_app` resolves
  the channel once, opens the DB and `TokenStore` under that dir.
- **Server dir:** same channel; on Linux it's `$XDG_RUNTIME_DIR/<channel>`, elsewhere
  `<app_data_dir>/<channel>`. The app hands the channel to the server via
  `PRAGMA_SERVER_CHANNEL` + `PRAGMA_APP_DATA_DIR` env vars. The socket file remains
  `daemon.sock` for SSH streamlocal compatibility.

**Remote projects use the same host-server protocol through an SSH streamlocal
bridge.** `ssh_host::connect_remote_project` probes the remote project, ensures a
protocol-compatible `pragma-server` is running under the production channel, registers
the host in `Hosts`, records the project-path route in `router.db`, and inserts the
client-local project metadata. Route preferences persist only non-secret SSH metadata
(`host`, `port`, `user`, `authMethod`); agent-auth routes reconnect in the background
on app startup and terminal spawn reconnects them on demand if the UI wins the startup
race, while password/key-passphrase routes stay disconnected until the user reconnects.
Worktree lifecycle git operations and `.pragma/scripts.json` setup/teardown commands
route through the owning host via `pragma-core` RPC.

## Native menubar + Troubleshooting menu

Built once in `src-tauri/src/lib.rs` `install_menu` — `Menu::default(app)` plus a
`Troubleshooting` submenu with **Restart Server** and **Open Server Logs**. Menu clicks
are forwarded as the `pragma:menu` Tauri event; `workspace-context` handles them via
`onMenuAction` in `lib/tauri.ts`. **Restart Server** calls `restart_daemon`
(`PtyClient::restart` = kill + respawn + confirm reachable) with a `sonner` toast.
**Open Server Logs** opens the `log` tab; logs load through `read_daemon_log`
(`PtyClient::read_log`, reading `log_path()` — beside the socket, not app data). Add a
menu action: id const + item in `install_menu`, `MenuAction` variant +
branch in `handleMenuAction`.

## Deep links (`pragma://open`)

`pragma://open` opens the app and starts the new-session flow. Optional query params:
`agent` (agent id; falls back to the default/first when missing or unknown),
`message` (the prompt, **base64-encoded** — decoded before display), `worktree`
(target worktree branch id), and `autoSubmit` (truthy → launch immediately, bypassing
the dialog). The scheme is registered in `tauri.conf.json` (`plugins.deep-link.desktop.schemes`)
via `tauri-plugin-deep-link`. `src-tauri/src/lib.rs` `install_deep_links` registers it at
runtime (Linux), stashes a cold-start URL in `PendingDeepLink` (drained once by the
`take_pending_deep_link` command), and emits every runtime URL as the `pragma:deep-link`
event. `workspace-context` parses it with `parseNewSessionDeepLink` (`lib/deep-link.ts`):
auto-submit launches via `startSession`; otherwise it dispatches the `pragma:new-session`
window event that `ProjectSidebar` opens the prefilled `NewAgentSessionDialog` with. Note:
deep links only reach a packaged/registered app — `tauri dev` on macOS won't receive them.

## Terminal rendering (xterm + WebGL)

Terminal output → xterm in `src/lib/terminal-manager.ts`; never route through React
state or the workspace reducer. Each terminal renders through the **WebGL addon**
(`@xterm/addon-webgl`), loaded right after `terminal.open()` — xterm's DOM renderer is
the dominant source of perceived typing latency. Loading is wrapped in `try/catch` and
`onContextLoss` disposes the addon, so a missing/lost WebGL2 context falls back to the
DOM renderer.

Frontend output writes are serialized through xterm's write callback
(`pendingOutput` / `writeInFlight`) to coalesce bursts behind the in-flight
parser/render pass. Scrollback is bounded to 500 lines (`TERMINAL_SCROLLBACK_LINES`).

**Keystroke input is fire-and-forget and pipelined:** `onData` fires `ptyWrite` without
awaiting; on the Rust side `pty_write` only _enqueues_ onto a dedicated writer thread
(`input_tx` / `start_input_writer` in `pragma-client`) that owns its own daemon
connection. The writer drains any already-queued same-session input into one frame and
sends `write_input_frame` binary frames; there is no per-keystroke JSON request or
daemon response. `resize`/`kill` use the separate pooled `request_conn`.

**Native OS text-editing chords** (macOS Cmd+Backspace/Left/Right,
Option+Left/Right/Backspace; Linux Ctrl+Left/Right/Backspace/Delete) are translated to
readline control characters by `nativeEditingSequence` in `lib/native-editing.ts` inside
xterm's `attachCustomKeyEventHandler`, checked **before** configured Pragma shortcuts.
Shift-modified variants are left alone so xterm's shift-selection keeps working.

**Shift+Enter is rewritten to ESC+CR** in the same handler so TUI REPLs (Claude Code,
opencode, Codex) insert a soft newline instead of submitting.

Terminal grids are capped at 240×90 cells (`MAX_TERMINAL_COLS` / `MAX_TERMINAL_ROWS`)
before both xterm and PTY resize — fullscreen TUIs redraw the entire grid per
interaction, so unbounded sizes regress latency.

**Wheel reports are rate-limited** (not rewritten) while a TUI has mouse tracking on.
An `attachCustomWheelEventHandler` in `terminal-manager.ts` drops events that arrive
within `MOUSE_WHEEL_REPORT_INTERVAL_MS` of the last forwarded one, **only when
`terminal.modes.mouseTrackingMode !== "none"`** — with tracking off, xterm scrolls its
own viewport and is left untouched. The interval is the scroll-feel knob; tune it rather
than removing the throttle or rewriting reports.

**Terminal font:** Nerd Font-first stack (`JetBrainsMonoNL Nerd Font`, …) at **fontSize
14 / lineHeight 1.0**. 14px is required — at 13px macOS WebKit rounds the cell to 15px
and half-block glyphs get a 1px seam. See `TERMINAL_FONT_FAMILY`, `TERMINAL_FONT_SIZE`,
`TERMINAL_LINE_HEIGHT` in `terminal-manager.ts`.

## Shell-driven tab titles

The daemon parses OSC 0/2 out of the raw PTY stream and emits a `Title` event. The
Tauri proxy forwards it as `PtyEvent::Title`; the non-React `TerminalManager` fans it
out via `onTitle(tabId, listener)`; workspace context dispatches `set-auto-title`.
`Tab.userRenamed` is the single guard: once set (via `rename-tab` action + `rename_tab`
Tauri command, which sets `user_renamed = 1` server-side), the title is permanently
locked against future shell pushes.

**CLI-driven tab/worktree mutations:** brokered `pragma-cli` commands are executed by
`src-tauri/src/control.rs`, then emit `worktreeChanged` / `tabsChanged` Tauri events.
`workspace-context.tsx` listens for those events and refreshes the selected project's
SQLite snapshot; `tabOpened` also selects the target worktree/tab so CLI-opened tabs are
visible immediately.

## Drag-and-drop

**HTML5 drag-and-drop requires `"dragDropEnabled": false`** on the window in
`tauri.conf.json`. It defaults to `true`, which makes Tauri capture OS drag/drop at the
native level, preventing in-page drag events from firing. WebKit withholds `dataTransfer`
payloads until the `drop` event, so the dragged tab id is tracked in shared React state
(`components/tabs/tab-drag-context.tsx`).

## Native browser webviews (BrowserView)

Native browser webviews float **above** all HTML. The shared `isDragging` signal hides
native overlays for the duration of a drag so drop zones underneath become reachable;
drop-zone geometry lives in `components/tabs/tab-drag.ts`.

Any HTML overlay that opens over a browser pane (dropdown, popover) would be clipped by
the native webview, so shadcn `DropdownMenu`/`Popover` roots register with
`lib/native-overlay.ts` while open; `BrowserView` steps its webview aside whenever
`useNativeOverlaySuppressed()` is true. For a menu/popover, `BrowserView` first captures
a still (`browser_snapshot` → PNG data URL via `xcap`) and paints it in the placeholder
so the pane looks unchanged behind the overlay. New floating UI using those two
primitives gets this for free; anything else that must paint above a browser must wrap
its open window in `useSuppressNativeOverlayWhile(open)`. The file-tree context menu
also registers via `useSuppressNativeOverlayWhile(open)`.

## Split / tab-bar model

One `splitRootByWorktree` layout per worktree. Tabs inside a real split are "split
members"; all others are "normal" top-bar tabs. `TerminalTabs` shows normal tabs plus a
single **parent tab** for the whole split (named after its top-left pane). Splitting
pulls only the **active** tab into the new group. Dropping a tab on a pane's **content**
always splits (four quadrant zones via `dropTargetAt`); dropping on a pane's **tab bar**
stacks it into that pane. Each `PaneBar` has its own "+" that creates a tab inside that
pane; the top strip's "+" and `⌘T`/`⌘B` always add normal top-level tabs.

**Split layouts persist in SQLite** (`splits` table, v4 migration — one row per
worktree, cascade-deleted with the worktree). The layout is an opaque JSON blob
(`SplitLayoutNode`) stored/returned verbatim by Rust via `list_splits` /
`set_split_layout` / `clear_split_layout`. An effect in `workspace-context.tsx` persists
on every change: only real splits (`root.kind === "split"`) are written; single-pane
worktrees clear their row. `rootsForTabs` must **not** drop roots for worktrees outside
the loaded project's tab snapshot — that loses splits on project switch. Restored node
ids pass through `reserveSplitNodeIds` so the counter never collides.

## Files & Changes right sidebar + editor/diff tabs

Right sidebar lives in `components/right-sidebar/`; cosmetic state (collapsed / subtab
/ width) persists to **localStorage**, not SQLite. Two subtabs:

**Files** — lazy `FileTree`, inline create + inline rename. Right-click → **Rename**
replaces the row label with `<RenameEntryInput>` (pre-fills current name, selects
basename). `commitRename` calls `renameFile(worktreeId, from, to)` then bumps the
parent's nonce. On the backend, `fs::rename_file` resolves both paths through
`resolve_in_worktree`, refuses to overwrite an existing destination, uses
`std::fs::rename` (atomic on same FS, works for files and directories).

**Selection + delete:** single click selects (`selectedFile`, rendered with
`outline outline-1 outline-cyan-400/60`). Right-click → **Delete** (red), or press
**⌘+Backspace** (macOS) / **Ctrl+Delete** (Linux) — registered as `deleteFile` in
`packages/constants/schema.json` + the Rust `keybindings::default_config`. `deleteFile`
is skipped when focus is in a text-editing context (`isTextEditingContext` in
`lib/native-editing.ts`). The worktree is a git checkout so **delete has no
confirmation** — `git checkout -- <path>` / `git clean -fd` is the recovery path.
`fs::delete_file` refuses to recurse into non-empty directories.

**Changes** — three git lists (Staged / Unstaged / Committed). Changes polls
`worktree_changes` every 2s while mounted (and on window focus), updating in place
without re-flashing the loading state. **Clicking any file opens one unified diff**
(`DiffSide::Worktree` = base merge-base → working tree). `ChangeGroup` is generic over
per-row `fileActions` and per-header `headerActions`. Staging is reversible
(no confirmation); discard is irreversible (confirmation `AlertDialog`).

Once a child worktree has no staged/unstaged changes, commit controls are replaced by
lifecycle actions: committed changes show `merge_worktree_to_parent`; a fully
merged/no-change child shows `WorktreeDeleteDialog`. The left sidebar polls
`worktrees_merged_status` for the merge glyph as a fallback, and also subscribes to the
shared per-worktree file watcher so filesystem changes refresh the glyph immediately.

**Editor/diff tabs** — `editor` (CodeMirror 6, save on ⌘/Ctrl-S, **no autosave**) and
`diff` (read-only `@codemirror/merge`) as `TabKind`s, opened via `openFileTab` /
`openDiffTab` (deduplicated). Both views are syntax-highlighted via
`loadLanguageExtension` (`components/editor/codemirror-language.ts`) and the shared dark
`pragmaHighlightStyle` / `pragmaSyntaxHighlighting` in `codemirror-theme.ts`. Editor
dirty state is ephemeral in `state/editor-dirty-store.ts` (never in the reducer, never
persisted); closing a dirty editor routes through `ConfirmCloseProvider`.

**Icons:** vscode-icons render offline via `lib/file-icons.ts` (`addCollection` once —
never let `@iconify/react` fetch over the network). Launcher brand icons come from a
curated subset (`lib/brand-icons.json`, registered by `lib/brand-icons.ts`, imported
once in `main.tsx`) — never add the full multi-MB `@iconify-json/{lucide,simple-icons}`
packages; when you add a `brandIcon` to `values.json`, add that icon's body to
`brand-icons.json` too.

**All filesystem + git work is worktree-scoped:** every `fs.rs` / `git.rs` command takes
a `worktreeId` + relative path; `resolve_in_worktree` rejects `..`/absolute/symlink
escapes — **no absolute path ever crosses IPC**.

**⌘+End** (mac) / **Ctrl+End** (linux) is registered as `scrollTerminalBottom` and
scrolls the active terminal to the live cursor row.

**Escape closes any open modal:** radix `Dialog`/`AlertDialog` dismiss on Escape
natively; hand-rolled dialogs use the `useEscapeToClose` hook.

## Toasts

`sonner` (`@/components/ui/sonner.tsx` + `<Toaster />` mounted once in `main.tsx`).
Trigger via `toast.success(…)` from action handlers — never from inside the reducer.
Clipboard reads/writes go through `navigator.clipboard` with a try/catch surfacing
errors via `toast.error(…)`.

## Worktree lifecycle

`Worktree` rows carry a `hidden` boolean (v3 migration). Hidden rows are filtered out of
the sidebar via `buildWorktreeTree(worktrees, { predicate: (w) => !w.hidden })` and
surfaced through a "Show N hidden" toggle. When the user hides the currently-selected
worktree, the reducer falls back to the main worktree (or the first remaining root).

**Active selection persists across restarts.** The last active project and each
project's last active worktree are saved in the `settings` table under one opaque JSON
key (`activeSelection`) via `get_active_selection` / `set_active_selection` — Rust
stores the string verbatim (same pattern as split layouts). The mount-time `reload`
rehydrates via `hydrate-selection`; a persist effect writes on every selection change,
gated by `didHydrateRef` and deduped by `lastPersistedRef`.

## Prompt Kanban board

A **project-scoped prompt board** lives behind the sidebar's Kanban-icon button (it
replaced the new-session button). `state/kanban-context.tsx` (`useKanban`) is mounted in
`App.tsx` **inside** `WorkspaceProvider` and is **always alive**, so it works in both
shell modes. It owns a `mode: "normal" | "kanban"` switch: `WorkspaceShell` renders
`ProjectKanbanWorkspace` in place of the terminal `<section>` + right sidebar in Kanban
mode (the **sidebar stays**). Kanban **replaces** the shell rather than overlaying it —
native browser webviews (BrowserView) float above HTML, so an overlay would be clipped.

Cards persist in SQLite (`kanban_cards`, v8 migration; `db.rs` CRUD, `kanban.rs`
commands `list/create/update/move/delete_kanban_card`, typed in `lib/tauri.ts`). The
shared `KanbanPromptCard` shape lives in `@pragma/constants` (`KanbanPromptStatus` /
`KanbanCompletedAction` / `KanbanSchedulingMode`). The board is project-scoped: cards
load by `selectedProjectId` and reload after every mutation.

**Transitions are enforced, not free-form** (no drag): `draft → inProgress` only via the
card's Start flow; `inProgress → reviewNeeded` is **automatic** — `useKanban` listens to
`onAgentReport` and moves a card whose `agentTabId` matches a `done` report (live
attention/running is shown per card via `useTabAgentStatus`); `reviewNeeded → completed`
only after a completion-modal action succeeds; completed cards are read-only.

**Background launch** (`startBackgroundAgentSession` in `lib/agent-launch.ts`) is the
crux: starting a draft creates/reuses a worktree, creates a terminal tab, and spawns the
daemon PTY **directly** (`ptySpawn` + `ptyWrite`, no mounted `TerminalManager`) so the
board stays visible. The session persists in the daemon; opening the card later attaches
(`ptyAttach`) and replays scrollback with the agent already running.

**Completion** (`runCompletion`) reuses existing commands, never re-implements them:
commit+merge = `stageAll` → `aiGenerateCommitMessage` → `commitStaged` →
`mergeWorktreeToParent`, then asks about worktree cleanup; commit+PR =
`aiCommitAllAndGeneratePullRequestDraft` → `githubPushBranch` → `createPullRequest`
(records PR url/number, shown as a PR badge); manual marks complete and navigates.
Card-driven navigation (`openCardWorktree`) switches to `mode: "normal"` and leaves a
**Back to Kanban** control in the shell; the board's own **Back** button just exits
Kanban without that return affordance. The always-mounted `WorkspaceDialogs` hosts the
`NewAgentSessionDialog` + its deep-link listener (moved out of `ProjectSidebar`) so
`pragma://open` works in both modes.
