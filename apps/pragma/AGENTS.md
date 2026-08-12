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
│   │   ├── theme.ts             # `.pragma/theme.json` parse/merge/apply (CSS var overrides)
│   │   ├── theme-tokens.ts      # Themeable color catalog + defaults parsed from index.css
│   │   ├── theme-presets.ts     # Sourced built-in palettes adapted to light/dark theme files
│   │   ├── theme-color.ts       # The only oklch ⇄ sRGB boundary (culori)
│   │   ├── brand-icons.ts/json  # Curated offline icon subset (lucide + simple-icons)
│   │   ├── file-icons.ts        # vscode-icons rendered offline via @iconify/react
│   │   └── utils.ts             # cn() + small utilities
│   ├── hooks/                   # use-shortcuts (keybindings), use-escape-to-close
│   ├── components/kanban/       # Project prompt board (ProjectKanbanWorkspace, cards, draft/completion modals)
│   ├── state/
│   │   ├── workspace-context.tsx   # Projects / worktrees / tabs reducer + context
│   │   ├── kanban-context.tsx      # Project prompt board: cards, shell-mode switch, background launch, completion
│   │   ├── github-context.tsx      # GitHub auth state (useGitHub)
│   │   ├── theme-context.tsx       # Loads/merges global + project theme.json, applies on project switch
│   │   ├── agent-status-store.ts   # Runtime agent dots (useSyncExternalStore)
│   │   ├── agent-pins.ts           # Cosmetic localStorage agent pins
│   │   ├── worktree-pins.ts        # Cosmetic localStorage worktree pins (timestamped)
│   │   ├── right-sidebar-context.tsx
│   │   ├── left-sidebar-context.tsx   # Left project sidebar collapse/width (localStorage)
│   │   ├── editor-dirty-store.ts   # Ephemeral editor dirty state (never in reducer)
│   │   ├── review-done-store.ts    # Ephemeral per-file PR review done-toggle
│   │   ├── review-focus-store.ts   # Ephemeral "scroll this review file into view" request
│   │   └── fix-it-store.ts         # Ephemeral per-PR "fix it list" of flagged review comments
│   ├── App.tsx
│   └── main.tsx
└── src-tauri/                   # Rust backend
    ├── src/lib.rs               # App wiring, managed state, plugins, command registration
    ├── src/db.rs                # Legacy client-local SQLite migrations + typed CRUD
    ├── src/kanban.rs            # Tauri commands for the prompt Kanban board (CRUD + move)
    ├── src/pty.rs               # Thin pragma-client adapter + PTY channel forwarding
    ├── src/git.rs               # Git CLI helpers
    ├── src/github.rs            # GitHub auth (0600 token file, OAuth device flow, gh CLI)
    ├── src/fs.rs                # Worktree-scoped, path-safe filesystem commands
    ├── src/main.rs              # Thin entrypoint
    ├── tauri.conf.json          # Window/bundle config; bundles server via externalBin
    ├── tauri.macos.conf.json    # macOS-only window flags (transparency + overlay titlebar)
    ├── tauri.dev.conf.json      # Dev overrides (icons-dev/; "Pragma Dev" titles the window)
    ├── installer-hooks.nsh      # NSIS hooks: stop the detached sidecars before install/uninstall
    ├── installer-hooks.test.ts  # Guards NSIS sidecar coverage and safe MSI process handling
    ├── scripts/stage-daemon-sidecar.sh  # Builds + stages server, pragma-cli, and sidecars
    ├── scripts/stage-bundled-plugins.sh # Fast rebuild/restage for bundled plugins
    ├── binaries/                # Staged sidecars (git-ignored; built, never committed)
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
5. **Never block the main thread.** A plain sync `#[tauri::command]` executes inline in
   the webview IPC handler on the macOS main thread; while it runs, painting and every
   queued IPC call (terminal keystrokes included) stall — this was the cause of
   app-wide typing lag. Any command doing a daemon RPC (`host_rpc`), subprocess,
   network, or file I/O must be `async fn` (+ `spawn_blocking` for blocking work, see
   `run_pty_task`) or at least `#[tauri::command(async)]`. Only trivially fast work
   (in-memory state, one SQLite row, native window calls) may stay plain sync.
   `pty_write` is deliberately sync: it only resolves in-memory host state and performs a
   bounded `try_send`; all socket work remains on `pragma-client`'s writer thread. Keeping
   this enqueue command sync preserves invoke order for terminal bytes.

## UI: Tailwind v4 + shadcn/ui

- Add primitives with `bunx shadcn@latest add <component>` (writes to
  `src/components/ui/`). Don't hand-roll what shadcn provides.
- Compose primitives into feature components elsewhere in `src/`; keep `components/ui`
  for unmodified primitives.
- Use the `cn()` helper (`src/lib/utils.ts`) for conditional classes. Theme tokens live
  in `src/index.css` (`@theme`/CSS variables) — use semantic tokens (`bg-background`,
  `text-muted-foreground`), not raw colors.

### User themes (`.pragma/theme.json`)

`src/index.css` stays the **single source of truth for the shipped defaults**. The
themeable catalog is not mirrored in TypeScript: `src/lib/theme-tokens.ts` imports
`index.css` with `?raw` and parses the `:root` (light) and `.dark` (dark) blocks, so a
new color variable is picked up automatically — `theme-tokens.test.ts` fails until it is
also placed in a `THEME_TOKEN_GROUPS` section. Because Vitest stubs CSS imports to `""`,
`vitest.config.ts` sets `css: true`; don't remove it.

- Overrides live in an optional `.pragma/theme.json` at two scopes (path from
  `constants.theme.fileName`), read/written by `read_theme`/`write_theme`. Layers merge
  per token: `index.css` <- global <- project, so switching projects re-applies instantly.
- `applyThemeOverrides` injects one `<style id="pragma-theme-overrides">` at the end of
  `<head>`, under **doubled selectors** (`:root:root`, `.dark.dark`). A themed dark
  `sidebar` also gets a higher-specificity `.dark.dark.vibrancy` rule that mixes its
  selected tint to 40% opacity, preserving macOS desktop blur.
- Values are persisted as `oklch(...)` to match the defaults. `src/lib/theme-color.ts` is
  the only place that converts; the shadcn color picker speaks sRGB, so colors outside the
  sRGB gamut clamp when edited through it.
- Built-in palettes live in `src/lib/theme-presets.ts`, include sourced light and dark
  ramps, and replace only the selected scope's `colors` block when applied. Selecting
  Pragma removes that block so the stylesheet defaults, including macOS vibrancy, stay
  authoritative; merged values equal to a stylesheet default are also omitted.
- The app renders dark-only (`<html class="dark">`). The Theme settings page previews the
  light ramp by temporarily removing the `dark` (and `vibrancy`) classes.

## GitHub integration

`apps/pragma/src/lib/github.ts` is the **only** place `new Octokit()` happens — the
same discipline as the `invoke()` rule. Components import typed helpers
(`findPullRequestForBranch`, `createPullRequest`, `getChecksStatus`,
`listReviewThreads`/`resolveReviewThread`/`unresolveReviewThread`, …); they never build
a client. The client is lazily built from the stored token (`githubToken()`) and cached
by token, so sign-in/out rebuilds it (`resetGitHubClient`).

**Response cache.** `lib/github-cache.ts` is a stale-while-revalidate store over every
read helper (PR summary, comments, commits, files, reviews, threads, checks, branches).
Fresh hits return immediately; stale hits return the cached value and kick a background
revalidate so the next tick / subscriber sees fresher data without blocking paint.
`force: true` bypasses. Mutations (`createIssueComment`, `createPullRequest`,
`mergePullRequest`) seed or invalidate the relevant keys. The Pull Request tab, the
PR review tab (metadata + local file diffs), and the worktree-sidebar PR lifecycle
poll all ride this cache at a 10s cadence.

**Review threads.** `listReviewThreads` paginates GraphQL, requests `originalLine` as a
fallback when `line` is null (outdated anchors), and reads author avatars via
`... on User/Bot/Mannequin` fragments — `Actor.avatarUrl` is **not** on the GraphQL
interface and a bare `author { avatarUrl }` 400s the whole call (zero comments).

**PR lifecycle colors.** `pullRequestLifecycle` maps a summary to
`open | draft | merged | closed | none`. Sidebar merge glyph: green = open, purple
(`text-skill`) = merged, red = closed. Header chip adds a yellow `merging` state while
the merge mutation is in flight. Conversation comments post **optimistically**.

Everything **secret/OS/git** stays in Rust (`src-tauri/src/github.rs`): the token is
stored in a **`0600` plaintext file** (`github-token`, owned by `TokenStore`) — the
same model the `gh` CLI uses, and **never SQLite**. The OS keychain is deliberately
**not** used: keychain items are scoped to the app's code signature, so unsigned dev
builds re-prompt on every launch. The plaintext file has no signature check.

Also in Rust: OAuth **Device Flow** polling (`reqwest` blocking, no client
secret/PKCE), `gh` CLI detection/adoption, `origin`→`owner/repo`, fetch+ahead/behind,
conflict-aborting pull/sync, push, the local `base...HEAD` PR file diff, and remote-branch delete. Worktree-scoped
GitHub git operations must run through the owning host's `git` RPC so remote project
paths are evaluated on the remote host, not the desktop client. The
`oauthClientId`, scopes, and endpoint URLs are in `@pragma/constants` (`github` block);
the setup-skip flag persists in the `settings` table (`github.setupDismissed`).

Auth state is held by `state/github-context.tsx` (`useGitHub`) and gates both the
full-screen `GitHubSetupModal` and the **Pull Request** right-sidebar subtab. The PR
subtab (`right-sidebar/PullRequestTab`) resolves logged-out → create
(`CreatePullRequestView`, TipTap markdown editor) → view (`ViewPullRequestView`). A PR
view keeps each check-run/status name and state; its merge card shows passed/failed/pending
counts and expands to a per-check dropdown. When GitHub reports a PR as unmergeable, the
merge card becomes a conflict alert. Its **Sync with Base Branch** action syncs the head,
fetches the actual base repository (including cross-fork upstreams), and merges its latest
base branch into the current worktree; clean merges push immediately, while conflicts
remain for local editing. While Git reports an active merge, the card prompts the user to
resolve and commit the conflict, and offers a confirmed **Abort Merge** action that discards
conflict-resolution changes. A PR review opens a `pr-review` `TabKind`
(v7 `pr_number` column) rendered through
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

**Alert wording is templated in `@pragma/constants`, not written inline.**
`lib/agent-notification-text.ts` renders `agentStatus.notificationText` into a title
(agent name + what it wants) and a body naming the project, worktree, and tab the report
came from — `workspace-context` resolves those names with `describeAgentLocation` and
passes them as `AgentAlertOptions.location`. The same templates are rendered in Rust by
`crates/pragma-gateway/src/push/text.rs` for phone pushes, so a toast, an OS banner, and
a push read identically. Change the templates, and keep the two renderers in step.

`lib/gateway-presence.ts` reports this window's focus to the gateway
(`POST /v1/push/presence`, re-reported on a heartbeat) so a paired phone is not pushed an
alert the user is already reading here. "Focused" is OS focus **and** document
visibility, tracked as two independent inputs: an occluded or minimised window can still
hold OS focus, and it can be hidden and restored without Tauri ever emitting a focus
change, so reacting only to hiding would strand the window in the unfocused state and
buzz the phone for alerts the user can see. Only a change in the conjunction is reported,
so the heartbeat is not restarted on every visibility flip.

macOS agent system notifications are clickable: the frontend calls the macOS-only
`show_agent_notification` Tauri command instead of the generic notification plugin, and
Rust emits `pragma:agent-notification-clicked` with `{ projectId, worktreeId, tabId }`;
`workspace-context` routes that through `navigateToAgentLocation`. Non-macOS falls back
to the regular plugin notification.

Launchable agents are plugin contributions, not Tauri-loaded JSON files. Pure Pragma
plugins use `@pragma/plugin` `defineAgent`; Claude Code, opencode, Cursor, and GitHub
Copilot CLI agent definitions live in their host-tool plugin packages as the single source
of truth. Staging copies their bundles, manifests, and icons under the shared bundled-plugin
resource directory. Desktop and `pragma-plugins` discover them through the same manifest
path as global/project plugins; no built-in registry seam exists. Agent definitions
with the same plugin id obey scope precedence (`project > global > bundled`), so a local
development plugin replaces its shipped copy instead of contributing duplicate agents.
Agent definitions carry `id`, `name`, optional `iconPath`, `launch.command`, optional model
providers, optional
`prefillDelayMs`, optional `startupInput` (`[{ delayMs, data }]`, sent after `start` and
before prompt prefill), and optional prefill controls (`prefillMode: "bracketed" |
"plain"`, `prefillSubmit`, `prefillSubmitDelayMs`). The prompt body and its submit key
are always sent as two separate PTY writes (`prefillSubmitDelayMs` apart, default 200ms)
so a paste-aware TUI commits the text before the submit keypress lands — this is why
Kanban background launches and foreground launches both submit reliably across agents.
Use these only for generic pre-TUI gates / input semantics owned by that agent
definition; core must not hard-code per-agent keystrokes. `pragma-cli` is
installed/updated to `~/.local/bin` on production startup. Dev builds install it under
their isolated instance data directory (`<data-dir>/bin`) so concurrent worktrees cannot
overwrite each other's helper with an older binary. Daemon terminal sessions export the
matching `PRAGMA_CLI` and prepend its directory to `PATH`; production still warns when
`~/.local/bin` is absent from app startup `$PATH`.

Agent definitions may also declare typed `excludeFeatures`; this metadata crosses the
shared catalog so `agent verify` skips unsupported optional capability groups.

Model providers may be static arrays or async plugin functions. Pragma resolves model
lists lazily when the selector submenu is hovered/focused and caches the last result.
Host-specific CLI parsing belongs in the plugin agent's model provider, not Rust/Tauri
IPC. There is no provider-level Auto model; when a model has reasoning entries, the
model-only choice is shown as Auto reasoning. Built-in agents use the plugin SDK exec
service, which runs in the active project/worktree context.

Built-in agent icons live in each agent plugin package's `assets/` directory and are
referenced as Vite asset URLs passed through `iconPath`; do not store these host-tool
brand assets in `apps/pragma`. External plugin agents may pass a browser URL, an
absolute filesystem path, or a plugin-dir-relative icon path; relative paths resolve
against the plugin manifest directory and are converted to Tauri asset URLs.

Agent pins are cosmetic localStorage state in `state/agent-pins.ts`.

Worktree pins are cosmetic localStorage state in `state/worktree-pins.ts`
(worktree id → pin timestamp). The sidebar promotes pinned worktrees to roots
at the top (newest pin first); each row exposes a hover pin button, a
context-menu Pin/Unpin item, and a filled pin glyph that unpins when clicked.

**The desktop does not own plugin watchers — `pragma-server` does** (see
`crates/pragma-server/AGENTS.md`). It used to: the frontend started a `pragma-watch`
child per launched agent session and stopped them all whenever plugin contributions
were replaced. That tied a watcher's life to a frontend that restarts, switches
projects, and reloads plugins far more often than a session ends, so every such event
silently orphaned every running agent — mobile interjections and answers reached the
server and went nowhere, while the desktop noticed nothing because typing into the
terminal bypasses watchers entirely. Sessions outlive the app; watchers must too. Do
not reintroduce a watcher spawn here.

## Remote access (tunnel + pair modal)

`pragma-server/src/tunnel.rs` supervises remote-access tunnel exposing local HTTP
gateway to paired mobile device. It reads `tunnel` key of `~/.pragma/config.json`
(`{ command, urlPattern }`), falling back to `CONSTANTS.tunnel.default{Command,UrlPattern}`
so Rust and TS agree; `{port}` is the only template variable and is filled with the live
gateway port. The child is spawned with `std::process::Command` (never the shell plugin);
reader threads scan **stdout and stderr** against the regex (cloudflared prints to stderr).
Server-owned state holds child + status (`idle | starting | active(url) | error(msg)`).
`tunnel.enabled` persists toggle and restores tunnel on server startup. Tauri commands
`tunnel_start` / `tunnel_stop` / `tunnel_status` are thin RPC adapters (+ typed wrappers
in `src/lib/tauri.ts`), so desktop exit does not kill mobile forwarding.

The full-frame Settings workspace (native **Settings…**, `⌘,` on macOS) owns mobile
pairing; the project sidebar has no phone shortcut. `PairDeviceSettings` toggles the
tunnel and renders a `PairingPayload` QR (via `uqr`, offline). Encode/validate helpers
live in `src/lib/pairing.ts`. The tunnel deliberately survives leaving Settings.
"Regenerate token" calls `regenerate_gateway_token` (kills gateway, deletes the
`gateway-token` file, respawns) — paired devices must reconnect. Settings also reads
`gateway-devices.json`, which the gateway updates from authenticated mobile identity
headers, and exposes supported global/project `.pragma/config.json` values through forms.

## Settings sections

`components/settings/SettingsWorkspace.tsx` is the shell: a scope toggle (Global /
Project), a nav list, and one section component per panel (`SettingsCard` is shared).
Sections listed in `PROJECT_SECTIONS` support both scopes; everything else is
app-global and falls back to Plugins when the user switches to Project scope. The
**Automations** section (global scope) embeds `AutomationsWorkspace` and reads the
automations context rather than `config.json`, so like Theme it renders past the
config load state. `openSettings(section?)` deep-links a section (the command
palette's "Open automations" uses it).

**Keybindings** (`KeybindingsSection.tsx`) is a table of every action with the chord
that actually applies after the `default → global → project` merge, whether it differs
from the built-in default, and Record / Stop / Reset. While recording,
`setRecordingKeybinding(true)` mutes `useShortcuts` and `set_menu_accelerators_enabled(false)`
clears the native accelerators, so chords the app already owns (⌘T, ⌘W) can be
captured instead of firing. Writes patch only the recorded action+platform in the
selected scope's file through `read/writeKeybindingsFile`, then dispatch
`pragma:keybindings-changed` so live shortcuts reload. Rust validates every write with
`keybindings::validate_overrides`, so a bad patch can never break all shortcuts.

**Terminal** (`TerminalSection.tsx`) edits the `terminal` block of the scope's
`config.json` (`{ backend, distro }`) — the shell a plain new tab opens in. The
distribution list comes from `useWslDistros(worktreeId)`, which probes `list_wsl_distros`
**once per worktree**: the probe shells out to `wsl.exe`, so a distribution installed
while the app is running only appears after a reload or a worktree switch. The same hook
and the same `lib/shell-profile.ts` helpers back the new-tab menu, so the two surfaces can
never disagree about what is installed or hidden.

**The probe is host-scoped, and the worktree is what picks the host.** `list_wsl_distros`
does not run `wsl.exe` on the desktop machine — it sends a `wsl` RPC to the daemon that
owns the worktree (`ssh_host::client_for_worktree`), which for a local project is the
managed local server. A project opened over SSH runs its terminals on the remote machine,
so probing locally would both hide that host's distributions and offer local ones it
cannot launch. Pass `null` only where no worktree applies (global settings), which probes
the local host. Anything that fails — an unreachable host, a daemon too old to know the
method, no `wsl.exe` — degrades to an empty list, which hides every WSL affordance.

In the new-tab menu, **Terminal** is a submenu (PowerShell, then the distributions) only
when distributions exist; with none it stays a plain one-click item, because a submenu of
one is just a hover the user cannot skip. A pick from that submenu is passed to
`createTerminalTab(worktreeId, shell)` and persisted on the tab, so it survives a server
restart. **⌘T/Ctrl+T deliberately passes no profile at all**: the session layer then
resolves the project's `terminal` block, then the global one, so the shortcut always
opens whatever Settings currently calls the default — copying the default onto the tab
instead would freeze it at the value it had when the tab was opened.

**The submenu's "Default" badge means the shell Settings selected, never
`WslDistro.default`.** Those are two unrelated defaults and conflating them is the bug
this note exists to prevent: WSL's flag names the distribution `wsl.exe` starts without
`-d`, which says nothing about what Pragma opens. `useTerminalSettings` resolves the
badge from both config scopes with the same project-first, same-scope-wins rule the
server applies, so the badge always names the shell ⌘T would actually launch. A bare
`{ backend: "wsl" }` with no `distro` is resolved onto the WSL-default distribution by
`effectiveDefaultProfile`, otherwise it would match no menu entry and draw no badge at
all. Settings dispatches `TERMINAL_SETTINGS_CHANGED_EVENT` after writing so the badge
moves without a remount.

**Agent Status** (`AgentStatusSection.tsx`) edits the `agentStatus` block of the
scope's `config.json` (`{ notificationsEnabled, soundName }`). Clips live in
`CONSTANTS.agentStatus.soundsDirName` (`.pragma/assets/sounds`) under the home
directory or the project's main worktree, listed/read/imported through
`list_agent_sounds` / `read_agent_sound` / `import_agent_sound`. Uploads are duration-checked
in the webview (only it can decode audio) and byte-capped on the host. `lib/agent-status-settings.ts`
resolves the effective settings (project over global over `CONSTANTS.agentStatus`),
caches them until `pragma:config-changed`, and `agent-alert.ts` plays the chosen clip —
falling back to the built-in chime — before deciding whether to raise a notification.

## Workspace mirror publisher

`src-tauri/src/workspace_mirror.rs` mirrors the desktop's entire workspace state
(projects/worktrees/tabs) to `pragma-server` so a paired phone can render the session
launcher. `WorkspacePublisher` is managed Tauri state: a cheap cloneable handle whose
`trigger()` sends a non-blocking signal to a single worker thread. The worker drains
bursts with a ~250ms idle debounce, reads all rows from `Db` (`list_projects` +
`list_all_worktrees` + `list_all_tabs`), groups them by owning host, and sends each
host its `PublishWorkspace` snapshot. The work never runs on the macOS main thread.
Mutation commands (`create_tab`, `close_tab`, `rename_tab`, `set_tab_*`,
`create_plugin_webview_tab`, `create_worktree`, `rename_worktree`, `hide_worktree`,
`delete_worktree`, `add_project`, `clone_project`) and brokered `control.rs` handlers
(`worktree_create`, `worktree_delete`, `worktree_rename`, `worktree_set_hidden`,
`tab_open`, `tab_close`, `tab_rename`, `agent_session_launch`) all call `trigger()` after
their DB write.

Before each publish the worker runs `adopt_headless_worktrees`: any git checkout under
`<project>/.pragma/worktrees/` the DB does not know (created by `pragma-server`'s
headless `agentSessionLaunch` while the app was closed) is inserted as a worktree row
parented to the project's main worktree, keeping the directory name as its id so remote
clients' ids stay stable. The one exception is fanout worktrees: their hierarchy is
host-owned and git carries no parentage, so adoption reads the durable fanout snapshot
(`fanout_parentage`) and parents the coordination parent under its source and each
attempt under that parent — otherwise the host's pick-time `validate_finalize` rejects
the merge because an attempt is no longer a direct child of its fanout parent. Adoption
is local-only (remote SSH project paths are skipped) and best-effort.

## Remote agent session launch

`control.rs` handles the brokered `agentSessionLaunch` control method: it resolves or
creates the target worktree + a new terminal tab via the existing Rust paths, tags the
tab as agent-owned on the daemon (`setAgent`), replies `{ worktreeId, tabId }`
immediately, then emits the `pragma:agent-session-launch` Tauri event. The tab change is
announced as `tabOpenedBackground` so the UI refreshes without selecting the tab —
selecting would mount a terminal and spawn an empty shell that races the background
agent `ptySpawn` (leaving a plain terminal with no agent command or prompt). A
`workspace-context.tsx` listener runs the proven Kanban background-launch sequence
(`startBackgroundAgentSession` → `startWatcherForAgentSession`) so board-invisible
launches from a phone work identically to a Kanban card start. The PTY spawns
directly — no mounted terminal needed. Bracketed prompt prefills wait for the PTY's
alternate-screen enter sequence (bounded by the same 15-second fallback used by
headless server launches) before typing, so slow agent startup cannot swallow the
phone's prompt; plain-mode agents retain their configured fixed delay.

## Server sidecar + instance channel

See `crates/pragma-server/AGENTS.md` and `crates/pragma-client/AGENTS.md` for the
server/client internals. App-side notes:

**The server ships as a Tauri sidecar.** A release app launches it from beside its own
executable (`pragma-client::sidecar_executable("pragma-server")`); a debug app spawns it via
`cargo run -p pragma-server`. The local HTTP gateway ships the same way: debug builds
run `cargo run -p pragma-gateway -- --socket <daemon.sock>`, release builds run the
`pragma-gateway` sidecar. The sidecars are staged by `scripts/stage-daemon-sidecar.sh`
(`cargo build -p pragma-server`, `cargo build -p pragma-gateway`, plus copy with host
triple), wired in three places: `tauri:build`'s `beforeBuildCommand` runs it
`--release`, `tauri:dev` runs it (debug) before `tauri dev`, and the pre-push hook runs
it before `cargo check` because Tauri validates `externalBin` paths during compilation.
The server/gateway are spawned directly with `std::process::Command`, **not** the shell
plugin. `pragma-cli`, `pragma-ai`, `pragma-github`, and `pragma-automations` are staged
by the same script. Shipped plugin packages are staged under `resources/plugins/` using
`CONSTANTS.plugins.bundledDirName`; staging is serialized because pre-push and Tauri dev
may invoke it concurrently. While `tauri dev` is running, use
`bun run --filter pragma plugins:refresh` after editing a bundled host-tool plugin; the
frontend mtime poll then hot-reloads the staged bundle.

**The Windows installer must stop the sidecars, not just the app.** Windows locks a
running executable's image file, and Pragma's sidecars outlive the window on purpose —
`pragma-server` owns the terminal sessions, `pragma-gateway` serves paired phones. They
run from the install directory, which for the default `currentUser` NSIS mode is
`%LOCALAPPDATA%\Pragma`, so installing over a live instance aborts with
`Error opening file for writing: …\AppData\Local\Pragma\pragma-server.exe`. Tauri's
template only waits for `${MAINBINARYNAME}.exe`, so `installer-hooks.nsh` (wired in via
`bundle.windows.nsis.installerHooks`) stops the main binary first — the app respawns the
server and gateway when it sees them exit, so killing them under a live app just re-locks
the files — then every `externalBin` sidecar, from both `NSIS_HOOK_PREINSTALL` and
`NSIS_HOOK_PREUNINSTALL`. A locked file during uninstall is skipped _silently_ and leaves
`$INSTDIR` behind, so the uninstall hook is not optional. **Adding a sidecar to
`externalBin` means adding it to `PragmaForEachSidecar` in `installer-hooks.nsh`;**
`installer-hooks.test.ts` enforces that, because the failure is invisible until someone
installs over a running app.

**The per-machine MSI deliberately relies on Windows Installer Restart Manager.** Do not
add WiX `util:CloseApplication` entries for the app or sidecars. That custom action selects
processes only by executable basename and runs elevated, so an install, update, or
uninstall could terminate another user's Pragma instance or an unrelated same-named
process. Restart Manager discovers processes from locks on files owned by the MSI, which
keeps process selection tied to this installation. A headless sidecar that Restart Manager
cannot close may require a reboot; that is safer than force-terminating an unverified
process. `installer-hooks.test.ts` guards against restoring the removed basename-based WiX
fragment.

The NSIS hook warns before it kills, but only where nothing else would: with the window open
Tauri's own prompt covers it, so the extra dialog fires **only** when the app is closed
and a sidecar is still alive — the steady state after closing the window, where the
server is holding detached terminal sessions that replacing its binary will end. That
keeps the total at exactly one dialog either way. Silent (`/S`) and passive (updater)
runs never block on it. None of this touches runtime: the macros exist only inside
`setup.exe`/`uninstall.exe`, and `detach_spawned` still outlives the window as before.

**Anything the build writes into a watched directory will restart `tauri dev`.** The
watcher covers `src-tauri` _and_ every Cargo path dependency (`packages/constants`,
`crates/*`), and it reacts to the write itself, not to a content change. Because
`tauri:dev` stages sidecars, restages bundled plugins, and regenerates constants
immediately before starting `tauri dev`, each of those can kill the app and force a full
rebuild — on Windows the relink then collides with the still-running `pragma.exe`, which
holds a lock on its own binary.

The two halves are fixed differently, and the boundary was measured rather than assumed:

- **Inside `src-tauri`** — ignore it in `.taurignore` or `src-tauri/.gitignore`. The
  repo-root `.gitignore` does **not** work; the watcher never reads it. `binaries/` and
  `resources/plugins/` are ignored for exactly this reason.
- **Outside `src-tauri`** — ignoring is not available: a `**/src/generated/` pattern in
  `.taurignore` did not stop `packages/constants/src/generated/constants.ts`, and neither
  did a `.gitignore` placed inside that package. Such a generator must instead **not
  write when nothing changed** — see `packages/constants/scripts/generate-types.ts`, which
  compares before writing. This matters because `generate` runs from `pretest` and
  `pretypecheck`, so any `bun run test` alongside `bun run dev` used to restart the app.

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

## Native menubar + Settings / Troubleshooting menus

Built once in `src-tauri/src/lib.rs` `install_menu` — `Menu::default(app)`, native
**Settings…** (`⌘,` on macOS) opening a full-frame workspace with a back button, plus a
`Troubleshooting` submenu with **Restart Server** and **Open Server Logs**. Menu clicks
are forwarded as the `pragma:menu` Tauri event; `workspace-context` handles them via
`onMenuAction` in `lib/tauri.ts`. **Restart Server** calls `restart_daemon`
(`PtyClient::restart` = kill + respawn + confirm reachable) with a `sonner` toast.
**Open Server Logs** opens the `log` tab; logs load through `read_daemon_log`
(`PtyClient::read_log`, reading `log_path()` — beside the socket, not app data). Add a
menu action: id const + item in `install_menu`, `MenuAction` variant +
branch in `handleMenuAction`. Accelerators live in one `MENU_ACCELERATORS` table (they
mirror the default keybindings); the items are kept in `WorkspaceAccelerators` managed
state so `set_menu_accelerators_enabled` can suspend them while Settings records a chord.

Workspace accelerators (Settings, New Terminal Tab, Close Tab, Command Palette, Command
Mode) **must** be real menu items — the webview otherwise swallows chords like `⌘T`/`⌃T`.
`install_workspace_menu` builds them once, then hands them to `install_macos_workspace_menu`
or `install_non_macos_workspace_menu`; the latter covers **both Linux and Windows**, which
share Ctrl-based chords. Both non-macOS platforms append to the `window` submenu because
it is the only one `Menu::default` gives a stable id — Windows' File submenu gets a
generated id, so `menu.get("file")` can never resolve it. Keep the non-macOS arm gated
`#[cfg(not(target_os = "macos"))]`, never `#[cfg(target_os = "linux")]`: the latter
silently drops every accelerator on Windows _and_ trips `-D warnings` there, since all
five bindings then go unused.

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
state or the workspace reducer. Terminals use `@xterm/addon-webgl`; DOM rendering is too
expensive for interactive TUIs and can stall the rest of the webview. WebGL contexts live in a
bounded least-recently-used cache (`WEBGL_RENDERER_CACHE_SIZE`). Normal tab switches retain the
renderer and glyph atlas, avoiding the visible top-to-bottom repaint caused by dispose/reload.
A hidden terminal evicted after the cache fills keeps its xterm buffer, parser, and output stream;
`TerminalView` restores WebGL in a layout effect before the revealed tab paints. This supports
more terminals than the GPU context budget without replay or a visible fallback-renderer flash.
Visible split panes may temporarily exceed the warm-context budget; excess contexts are shed as
soon as those panes become hidden again.
Context loss gets bounded consecutive retries, and a successful paint resets that retry budget.
Keep `@xterm/xterm` and `@xterm/addon-webgl` pinned to versions built from the same upstream
commit: their texture-atlas contracts change together. The current aligned beta includes atlas
merge, shared-renderer invalidation, and texture-capacity fixes absent from stable 6.0/0.19.

Frontend output writes are serialized through xterm's write callback
(`pendingOutput` / `writeInFlight`) to coalesce bursts behind the in-flight
parser/render pass. Scrollback is bounded to 5000 lines (`TERMINAL_SCROLLBACK_LINES`).
Queued renderer output is byte-capped (`TERMINAL_PENDING_OUTPUT_MAX_BYTES`). Each stream tracks
an absolute server output-byte cursor: ordinary disconnect preserves xterm state and reconnects
from that cursor, so only missing bytes arrive and existing output is never replayed. The server
requests a bounded reset only when retained scrollback no longer covers the cursor. Renderer
overflow still performs destructive bounded recovery rather than growing the webview heap.
Stream generations make late attach/detach completions harmless. Each xterm parser write is at most
`TERMINAL_WRITE_CHUNK_MAX_BYTES` (64 KiB). Recovery invalidates the old stream immediately,
then waits for its current xterm write callback before reset/replay; if that callback does not
drain within the bounded timeout, the widget is recreated instead. Every normal parser write has
the same watchdog, so a lost xterm callback cannot permanently stall scrolling and echo. Never reset an xterm with
an outstanding write callback or let a late callback mutate replacement state.

Ordinary React unmount calls generation-tokenized `TerminalManager.park`: it marks the view
invisible but preserves the xterm instance, warm WebGL renderer, parser state, output stream, and
queued output. Remount reparents that same widget without detach, reset, replay, or forced
refresh unless its hidden renderer was LRU-evicted. A stale cleanup token cannot park a widget
already moved to a newer host. Closing the tab still calls `dispose`, which detaches, destroys
xterm, and kills the PTY.

**Keystroke input is ordered, fire-and-forget, and pipelined:** every xterm `onData` path uses
`writeWhenReady`. Input arriving before the current attach/spawn succeeds stays in a bounded
byte/message queue and flushes once, in order, only for the current connection generation.
Overflow is surfaced, never silently dropped. Once ready, sync `pty_write` invocations enqueue
in call order onto `pragma-client`'s dedicated bounded writer thread. That thread owns its daemon
connection, caps binary `write_input_frame` frames, and does not consume a frame or decrement
queue accounting until that exact frame is accepted. A socket failure retries the same bytes
with bounded exponential backoff before later bytes can advance. There is no per-keystroke JSON
request or daemon response. `resize`/`kill` use the separate pooled request connections.

Terminal focus is separate from fit and visibility. Only the active terminal in the focused
pane receives `TerminalManager.focus`, scheduled after React reveals/reparents its DOM. Hidden
tabs and active terminals in unfocused split panes must never receive focus; unrelated rerenders
must not steal focus from find/replace, rename fields, dialogs, or editors.

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

**Wheel reports are renderer-response-paced** while a TUI has mouse tracking on. Every wheel
event reaches xterm so trackpad pixel deltas keep accumulating; the first generated report is
sent immediately, then only the latest report waits until response bytes finish parsing and
`terminal.onRender` confirms WebGL painted the next frame. The write callback alone is not
backpressure: it fires before rendering.
Never release several reports per redraw: macOS trackpad momentum then outruns fullscreen TUI
rendering again and eventually starves the webview. A 250ms watchdog applies only when the prior
report produces no output. Once response bytes arrive, no further report is admitted while they
wait in xterm's parser; a separate short render watchdog covers a missing `onRender`. Sensitivity is 1 while mouse tracking is active (each
threshold crossing is one report) and 3 for local scrollback's pixel damping. Pacing applies **only when
`terminal.modes.mouseTrackingMode !== "none"`** — with tracking off, xterm scrolls its own
viewport and is left untouched. A new gesture after `MOUSE_WHEEL_GESTURE_QUIET_MS` recovers
from a prior report that produced no output at a scroll boundary.

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

**Agent tabs:** launching an agent tags the tab through the owning daemon (`Tab.agentId`,
`set_tab_agent` RPC adapter, `set-tab-agent` action) — the tab shows the agent's icon, its title seeds
with the agent's display name, and shell OSC titles are ignored entirely. Agent
`session-name` reports arrive on the agent event bridge and dispatch
`set-session-title`, renaming the tab on session create/rename/switch;
`userRenamed` still wins over all of it.

**CLI-driven tab/worktree mutations:** brokered `pragma-cli` commands are executed by
`src-tauri/src/control.rs`, then emit `worktreeChanged` / `tabsChanged` Tauri events.
`workspace-context.tsx` listens for those events and refreshes the selected project's
SQLite snapshot; `tabOpened` also selects the target worktree/tab so CLI-opened tabs are
visible immediately. `tabOpenedBackground` (mobile agent launches) refreshes without
selecting, so a terminal mount cannot race the background agent spawn.

## Window chrome — transparency is macOS-only

`transparent`, `titleBarStyle: "Overlay"`, `hiddenTitle`, and `macOSPrivateApi` live in
`tauri.macos.conf.json`, **not** `tauri.conf.json`. A transparent window only makes sense
where there is something behind it: on macOS that is the `NSVisualEffectView` vibrancy
layer `src-tauri/src/window_chrome.rs` installs. On Windows and Linux there is nothing,
and the compositor's own chrome (the DWM title bar, a GTK client-side header bar) renders
see-through instead of solid — the bug that put these flags in a separate file.

Two rules follow:

- **Tauri's config merge replaces arrays, it does not merge them** (`json_patch::merge`).
  `app.windows` is an array, so `tauri.macos.conf.json` carries the _whole_ window object,
  not just the macOS keys. Change one, change both.
- **Don't put an `app.windows` array in `tauri.dev.conf.json`.** It is applied via
  `--config` _after_ the platform file, so it would replace the array again and put
  transparency back on every platform. The dev build differs only by product name, and
  `window_chrome::apply` titles the window from `package_info().name` for exactly that
  reason.

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

### Design mode

The paintbrush toggle in the browser toolbar turns on an **in-page** element picker:
hovering animates a highlight box onto the element nearest the cursor, clicking it opens
a pill input, and "+" stages the typed prompt. Because the page is a native webview,
none of that can be React — it is `DESIGN_SCRIPT` in `browser.rs`, injected alongside
`focus_script()` into every browser page and inert until `browser_design_set` flips
`window.__pragmaDesign.setEnabled(...)`. The flag is mirrored into the page's
`sessionStorage` so design mode survives reloads and same-origin routing; `use-design-mode.ts`
re-asserts it on every `tab.url` change for the cross-origin case.

The overlay can't read Pragma's Tailwind variables (it lives in the user's page), so
`readDesignPalette` resolves `--primary`/`--popover`/`--ring`/… off the app document and
`browser_design_set` forwards them; the script re-declares them as `--pragma-*` on its
shadow host. `useDesignPalette` re-pushes on light/dark and theme-override changes, so
never hard-code overlay colors — add the token to `DesignPalette` instead.

Staged changes come back the same way focus/find pings do — a cancelled navigation to
`pragma-design://stage/<base64url>?token=<capability>` that `on_navigation` decodes and
re-emits as `browser-design-stage`. Rust generates a fresh per-tab capability whenever
design mode is enabled, keeps the expected value in native memory, injects it only into
the overlay closure, and rejects staging unless the presented token matches while that
native session remains active. Disable, full document navigation, and tab close clear the
capability; the existing URL-change re-assertion enables the new document with a fresh
one. Never reuse or expose the persistent gateway bearer token for this page-local flow.
The toolbar count badge (`DesignModePopover`) lists staged changes and
hands the lot to a **background** agent session (`createTab` + `startBackgroundAgentSession`,
the Kanban path) so launching an agent never steals focus from the page. The toggle is
promoted to the toolbar only for loopback URLs with an explicit port (`isLocalPortUrl` in
`lib/design-mode.ts`) and lives in the overflow menu otherwise; `buildDesignPrompt` in the
same file renders the origin/port, each element's HTML and route, and the user's own words.

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
(no confirmation); discard is irreversible (confirmation `AlertDialog`). Committed
changes use the Pragma parent branch as their baseline, falling back to the Git upstream
or matching remote branch for main/parentless worktrees.

Once a child worktree has no staged/unstaged changes, commit controls are replaced by
lifecycle actions: committed changes show compact remote sync with ahead/behind counts;
a no-change child shows `WorktreeDeleteDialog`. Sync pulls first, auto-aborts conflicts,
then pushes. The left sidebar polls `worktrees_merged_status` for the merge glyph while
visible. It deliberately does not open an eager recursive watcher for every worktree; file
watches are lazy, shared, and exist only while a mounted feature consumes file changes.

**Editor/diff tabs** — `editor` (CodeMirror 6, save on ⌘/Ctrl-S, **no autosave**) and
`diff` (read-only `@codemirror/merge`) as `TabKind`s, opened via `openFileTab` /
`openDiffTab` (deduplicated). Both views are syntax-highlighted via
`loadLanguageExtension` (`components/editor/codemirror-language.ts`) and the shared dark
`pragmaHighlightStyle` / `pragmaSyntaxHighlighting` in `codemirror-theme.ts`. Editor
dirty state is ephemeral in `state/editor-dirty-store.ts` (never in the reducer, never
persisted); closing a dirty editor routes through `ConfirmCloseProvider`. The shared
load/save/dirty/⌘-S lifecycle lives in `components/editor/use-editor-file.tsx`.
`vite.config.ts` must dedupe `@codemirror/state`: CodeMirror validates extensions with
`instanceof`, and separate direct / transitive copies crash optimized builds. Do not alias
the package to its physical `dist` file; that bypasses package-aware dynamic language loading.

**Inline AI edit** — ⌘/Ctrl+K in any CodeMirror surface (plain editor tabs and the
markdown Raw mode) opens a design-mode-style pill under the highlighted lines; the
answer lands in the buffer as a red/green diff with an accept/reject bar above each
hunk. Pieces:
`lib/inline-edit.ts` (pure: apply the model's exact-text replacements, build the preview
document and its hunk offsets from `@codemirror/merge`'s `Chunk`, resolve one hunk),
`components/editor/inline-edit-extension.ts` (session `StateField`, decorations, the
keymap), `use-inline-edit.tsx` (controller + portals), `InlineEditPrompt.tsx` /
`InlineEditHunkBar.tsx`. Rules that are easy to break:

- **The buffer is the source of truth, not the file.** The request carries the live
  (often unsaved) document and the model gets **read-only** tools (`read`, `grep`,
  `find`, `ls`) so it can search the repo but cannot write it — see
  `INLINE_EDIT_TOOLS` in `@pragma/ai-helpers`. Nothing reaches disk until the user
  accepts a hunk and saves.
- **Local worktrees only (for now).** `ai_inline_edit` (and the other worktree-scoped
  AI commands) spawn `pragma-ai` on the desktop client with a local `--cwd`. Remote
  SSH paths must not be passed through — they would fail or inspect an unrelated local
  checkout. The Rust command refuses remote hosts; the editor also skips opening the
  pill when `remoteWorktrees[worktreeId]` is true. Host-routed AI is future work.
- **While reviewing, the document holds both sides**, so ⌘/Ctrl-S is intercepted and
  refuses with a toast until every hunk is resolved.
- **Hunk offsets are only valid against the document they were computed from.** Resolving
  one hunk shifts the rest; the `StateField` maps them through `tr.changes` — never cache
  them outside it.
- The keyboard scheme is the primary interface (buttons mirror it): Enter submits,
  Esc backs out (rejecting everything left in a review), Abort (while running) drops
  the in-flight request and restores the editable pill, ⌘/Ctrl+Enter and
  ⌘/Ctrl+Backspace accept/reject the focused hunk, adding Shift widens either to all
  hunks, and Alt+↑/↓ walks between them. The prompt UI mirrors the browser design-mode
  pill (rounded input + circular action button; pulse + stop while loading).
- Block widgets are React portals over the shared `components/editor/portal-widget.ts`
  (also used by `MergeDiff`'s review comments): identity is the widget `key`, so a
  redraw reuses the DOM and the prompt box keeps what the user typed.

**Markdown tabs** — `editor` tabs whose file is markdown (`isMarkdownPath`: `.md` /
`.markdown` / `.mdown`, **not** `.mdx` — JSX would be mangled) render
`components/editor/MarkdownView.tsx` instead of `EditorView` (dispatch in
`SplitHost`'s `PANE_CONTENT_RENDERERS`; the `TabKind` stays `editor`). A top-right
toggle switches WYSIWYG (TipTap + `tiptap-markdown` for GFM I/O, table kit, task
lists, `MarkdownToolbar.tsx`) and Raw (the standard CodeMirror surface). Both modes
share the same file lifecycle; unsaved edits survive the mode switch via
`currentDocRef`. ⌘/Ctrl+K in WYSIWYG switches to Raw, carries the selected text into
CodeMirror, and opens the shared inline AI edit prompt there so review hunks retain the
standard CodeMirror diff workflow. The `getMarkdown` TipTap helper is shared with the PR body editor
in `components/editor/tiptap-markdown.ts`.

**Scratchpad tabs** — agent-authored MDX lives under each worktree's local,
Git-excluded `.pragma/scratchpads/` directory and opens as dedicated `scratchpad`
`TabKind`. Only `pragma-cli scratchpad create --title <title> <file.mdx>` creates one:
broker validates current registered agent tab, adds required JSON-in-YAML frontmatter,
writes through owning host, and opens tab. Frontend rejects MDX without that frontmatter.
`ScratchpadView` has two modes: Editor rich-edits ordinary Markdown and renders MDX React
components as live, lossless TipTap atom node views; Raw reuses CodeMirror + inline AI.
A JSX flow element whose children can be edited is **not** atomized:
`preprocessMdxForTiptap` emits a `pragma-mdx-container` (`MdxJsxContainer`, a non-atom
`block+` node) carrying the open/close tags as attributes, and the children parse as
ordinary editable document content framed by tag chips (`nestedMarkdownRegion` in
`mdx-hybrid.tsx` decides; the children travel as pre-rendered HTML in `data-content`,
decoded by the node's `parse.updateDOM` hook). Serialization writes the tags back around
the children, so the source stays lossless. **Rewriting is recursive, and the depth rule
is the whole point:** a plain HTML tag renders nothing of its own and supplies no React
context, so it always becomes a container and each child is rewritten in turn — a
container, or its own atom — which is what keeps `<article><section><div>` markdown
editable three levels down instead of freezing the region into one iframe. A _component_
(capitalized name, or a member expression) only renders correctly as a whole, so it stays
an opaque live-preview atom unless its children are pure markdown. Rewriting also descends
through `blockquote`/`list`/`listItem`, so an `<aside>` inside one list item no longer
atomizes the entire list. Markdown that is inline JSX (`<div>text</div>` on one line,
`Before <Badge>x</Badge> after`) is a _text_-level element whose children MDX does not
parse as markdown; its enclosing block stays an atom, deliberately. Container children are
rendered to HTML with remark-rehype (`allowDangerousHtml`, so nested container/atom markup
survives) plus a task-list rewrite into `data-type="taskList"`/`"taskItem"` — without it a
nested `- [x]` loses its checkbox on the way in.
Rendered components compile with `@mdx-js/mdx` and `esbuild-wasm` into auto-sized,
opaque-origin `sandbox="allow-scripts"` iframes inside the editable document.
Local relative/package imports resolve before HTTPS/esm.sh fallback. Imported JSX
components and document root render under error boundaries. Range comments persist in
sibling JSON and submit as one prompt to attached agent; missing attachment opens
same-worktree agent-tab picker. Renderer bridge requests are token-scoped and can only
prompt same-worktree tabs or read same-worktree status. Public scratchpad APIs/components
live in `@pragma/scratchpad`; heavy compiler/runtime code lazy-loads only when an Editor
document contains MDX regions.

**A file-backed tab re-reads in place, never by remounting.** `useEditorFileLoader` owns
this for every editor surface (plain, Markdown, scratchpad). Its `load()` — initial mount
and the error-retry button — passes through `{ kind: "loading" }`, which tears the surface
down; a _refresh_ (worktree watch event for the open path, or the window regaining focus)
must not, because remounting a scratchpad discards TipTap state and rebuilds every MDX
iframe. Refreshes therefore patch the `ready` state in place, no-op when the bytes match
what is already loaded (so the tab's own save doesn't bounce off its own watch event), and
swallow read errors so an atomic replace caught mid-flight can't replace good content with
an error screen. A dirty tab is never overwritten: the loader raises `externalChange`
instead, and `ScratchpadView` renders a "Changed on disk — reload" button that calls
`reloadFromDisk()`. The window-focus re-read is deliberate redundancy — the watch is a
live subscription that a dropped socket, a sleeping machine, or an unmounted tab can miss,
and a buffer that only a tab close fixes is worse than one extra read. `ScratchpadsCard`
watches the same events for `.pragma/scratchpads/` so an agent creating a scratchpad shows
up in the sidebar without waiting on unrelated tab churn.

**A scratchpad frame never restates a color.** The sandbox has its own document, so it
sees neither Tailwind nor `index.css`. `lib/scratchpad-theme.ts` reads the computed value
of every `THEME_TOKENS` variable (plus the radius/font/shadow support variables) off the
live `<html>` element and hands the frame one `:root` block in a
`<style id="pragma-scratchpad-theme">`, so `.pragma/theme.json` overrides apply inside
components for free. Theme edits (`THEME_CHANGED_EVENT`) and root class changes rewrite
that block through a `theme` bridge message rather than rebuilding the bundle — a rebuild
would discard the component state the scratchpad is holding. Never hard-code a hex value
in the preview document or in `@pragma/scratchpad`.

Vite must allow CORS from the literal `null` origin in development: sandboxing removes
the iframe's origin, while `scratchpad-frame-runtime.tsx?worker&url` remains a Vite module
graph until production bundling. Keep that exception alongside Vite's restricted localhost
origin matcher; never replace it with unrestricted `cors: true` or weaken the iframe with
`allow-same-origin`. That runtime and its prebuilt `packages/scratchpad/dist` dependencies
are also excluded from `@vitejs/plugin-react`: React Refresh expects the app's preamble
and crashes when its injected HMR code runs in the isolated frame; Vite's standard
TSX/JavaScript transforms are sufficient there. The frame bootstrap still defines
no-op `$RefreshReg$` / `$RefreshSig$` hooks because Vite's optimized development build of
`react-dom/client` contains signature calls even though the frame itself does not use HMR.

**PDF tabs** — `editor` tabs whose file is a `.pdf` (`isPdfPath`) render
`components/pdf/PdfView.tsx` instead of `EditorView` (same `PANE_CONTENT_RENDERERS`
dispatch; the `TabKind` stays `editor`). It is a **viewer**, not an editor: no dirty
state, no save, no `use-editor-file` lifecycle. Rendering is EmbedPDF's headless React
plugins (`@embedpdf/plugin-{viewport,scroll,render,zoom,selection,interaction-manager,
document-manager}`) styled with Tailwind here — `PdfDocument` wires the plugin stack,
`PdfPage` composes one page, `PdfToolbar` / `PdfZoomControls` / `PdfPageControls` are the
chrome, `use-pdf-zoom-shortcuts` binds ⌘/Ctrl `+` `-` `0` `9`. Two things are load-bearing:

- **The pdfium wasm is bundled, never fetched, and its URL must be absolute.**
  `pdf-engine.ts` imports it as `@embedpdf/pdfium/pdfium.wasm?url` and passes
  `fontFallback: null`; EmbedPDF's default is a jsDelivr URL plus CDN font packs, which a
  desktop app must not depend on. Vite hands back a **root-relative** path, and the engine
  runs in a worker created from a `blob:` URL where that path has no base — WebKit fails it
  with `TypeError: URL is not valid or contains user credentials.` EmbedPDF swallows the
  error, so the only symptom is a document stuck on "opening" forever. `absoluteWasmUrl()`
  resolves it against `location.href`; `pdf-engine.test.ts` pins that. That module also
  refcounts one shared engine across every open PDF tab — it is a worker plus a
  multi-megabyte module, so per-tab engines are not an option.
- **The bytes arrive in chunks.** `read_file` refuses binary content outright, so
  `use-pdf-file.ts` walks `readFileChunk` until the host reports `eof` (see
  `constants.files`). This is also why a remote SSH project's PDFs work unchanged.

**Media tabs** — `editor` tabs whose file is a raster image, video, or audio clip
(`isMediaPath` in `components/media/media-path.ts`) render `components/media/MediaView.tsx`
instead of `EditorView` (same `PANE_CONTENT_RENDERERS` dispatch; the `TabKind` stays
`editor`). **SVG stays in the code editor** so the source remains editable. The viewer is
read-only: images and videos fit the pane (capped at native size so small media stays
centered), with wheel / toolbar / ⌘± zoom and drag-to-pan; audio uses `AudioPlayer`
(themed play/seek/volume over a hidden `<audio>`, plus a file-type icon well). Bytes load
through the shared chunked reader in `lib/binary-file.ts` (`useBinaryFile` — also what PDF
uses) and are served to `<img>` / `<video>` / `<audio>` as a revoked-on-unmount blob URL.

A pane renders **only its active tab**, so switching tabs unmounts the viewer outright.
Both caches exist for that reason and neither is an optimization to "clean up": the engine
survives zero references for `ENGINE_IDLE_MS` and `lib/binary-file.ts` keeps the last few
files' bytes, or every switch back would re-start the wasm worker and re-read the whole
file. The byte cache hands out `buffer.slice(0)` because the engine may transfer the buffer
to its worker and detach it; a reload (retry, or the file changing on disk) drops the entry.

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

## Fanout comparison

A fanout's attempts are shown in `components/fanout/FanoutComparison.tsx`, which
**replaces** the centre workspace and the right sidebar rather than overlaying
them — native browser webviews float above HTML, so an overlay would be clipped.

- **One shared column model.** `widths` in the comparison drives the sticky
  header and every section row. Independent `ResizablePanelGroup`s per row drift
  apart the moment a row collapses, so there is deliberately only one. Columns
  divide the viewport width evenly on mount (measured via a `ResizeObserver`),
  so every section spans the full tab; manual drags are preserved across
  resizes.
- **Sessions are real terminals.** Each cell mounts the ordinary `TerminalView`
  for the attempt's tab: input, scroll, resize, and status behave as anywhere
  else. Collapsing the section unmounts the host, which parks the terminal
  through `TerminalManager` and releases its renderer — it never kills the PTY.
- **Diffs are lazy, pinned to the base commit, and expanded by default.** A file
  row mounts its cells on mount; every diff is `fanout.baseCommit → attempt
  working tree` (`base_file_diff`), so uncommitted attempt work shows and the
  comparison survives the parent advancing. Each cell renders a
  `UnifiedDiff` — a single-column, changed-lines-only view (deletions red,
  insertions green, no unchanged context) rather than a side-by-side old/new
  `MergeDiff`.
- **Scratchpads pair by exact path, then by normalized title** (`lib/fanout.ts`);
  an unmatched document keeps its own row with empty cells.

Fanout state itself is host-owned: `state/fanouts-context.tsx` reads
`list_fanouts` once and then follows the `pragma:fanouts` bridge. The sidebar
renders an explicit group row per fanout (`components/sidebar/FanoutGroup.tsx`)
and hides its attempts from the ordinary tree — `parentId` alone cannot tell an
attempt from a hand-made nested worktree.

## Toasts

`sonner` (`@/components/ui/sonner.tsx` + `<Toaster />` mounted once in `main.tsx`).
Trigger via `toast.success(…)` from action handlers — never from inside the reducer.
Clipboard reads/writes go through `navigator.clipboard` with a try/catch surfacing
errors via `toast.error(…)`.

## Worktree lifecycle

`CreateWorktreeDialog` only _collects input_. It fetches the project main worktree's
remote status before creation; when main is behind it offers cancel, create without
pulling, or pull then create. As soon as the last question is answered it hands the run
to `worktree-creation-context` and closes — creation never blocks the app behind a modal.

Its **Fan out** mode is the same form with the single agent picker swapped for the
repeatable attempt rows (`components/dialogs/FanoutRows.tsx`): branch name, display
title, and prompt keep their meaning, and there is no attempt-count ceiling. A fanout
**always** branches a fresh coordination parent (`parent.kind: "new"`) from the worktree
the dialog was opened on — the desktop never fans out into a worktree the user is already
working in, so the branch field is always required. The `existing` parent kind stays in
the contract for `pragma-cli fanout create --parent`.

`WorktreeCreationProvider` runs the flow (optional `githubPullBranch`, `createWorktree`,
then the terminal tab or agent session) and exposes its step list. `WorkspaceShell`
swaps `WorktreeCreationScreen` in for the terminal area while it runs — full-frame like
Kanban rather than an overlay, because native browser webviews float above HTML. Steps
are "Syncing base" (only when the user chose to sync), "Creating worktree", and "Running
scripts". The scripts step is appended from the `pragma:worktree-create-stage` Tauri
event, which `create_worktree` emits just before the project's `setup` commands run
(they run inside that single command, so the frontend cannot otherwise see them); no
event means no setup scripts and no step. A failure keeps the screen up with the message.
Failures before creation offer Dismiss; failures while refreshing or opening an already-created
worktree retain the launch request and offer Retry, which reopens it without creating the branch again.

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

## Project command palette

`Cmd+P` (macOS) / `Ctrl+P` (Linux) opens
`components/command-palette/CommandPalette.tsx`. It searches only non-hidden worktrees
in selected project. Local worktree/tab/agent rows render immediately; PR discovery and
host filename/code search hydrate independently. Selecting a worktree scopes palette
without navigating; Backspace on empty scoped query clears scope. Agent status rows resolve
their qualified agent id through the plugin catalog and render the agent's bundled icon.
Escape returns from a scoped worktree or editor submenu before closing the palette.
Active run/build commands appear as running-script rows with their worktree. Enter opens
the script tab; Shift+Enter closes that script tab through normal managed-script cleanup.

Open TCP listeners appear in both the left-sidebar Ports card and regular palette search.
`open-ports-context.tsx` polls one project-scoped `list_open_ports` command and shares the
snapshot between both surfaces. The host only returns sockets whose PID is the live terminal
shell or one of its descendants; the frontend additionally requires a matching visible,
persisted terminal tab. Enter/click focuses that tab, while palette Shift+Enter closes the tab
through normal PTY cleanup. Never broaden this to host-wide listeners: Pragma internals and
processes not launched from a user terminal tab must stay hidden.

Filename/code search is one bounded `palette_search` Tauri call. Tauri resolves trusted
roots from SQLite and routes them to owning host; `pragma-core::fs` returns only relative
paths, excludes gitignored files, and supports cancellation/deadlines. File rows show the
filename with full path and worktree at right so duplicate names remain distinguishable.
`worktree_mru` is client-local SQLite state,
touched by centralized workspace-selection effect. Cross-worktree file/tab actions use
explicit `activateTabLocation` / `openFileLocation` APIs to avoid stale selection races;
code matches use ephemeral `editor-location-store.ts` to reveal source line.

Typing `>` enters command mode; `Cmd+Shift+P` / `Ctrl+Shift+P` opens it directly.
Commands reuse existing workspace actions for remote access, server troubleshooting,
tab/view navigation, and editor launch. Editor commands drill into non-hidden worktrees
sorted by `worktree_mru`; remote worktrees remain visible but disabled because editor
launchers run on the local client.

When Pragma AI is available (`useAi().available`) and the command query is non-empty,
the top row is **Ask AI {message}** — hidden for remote (SSH) worktrees, because the
sidecar still runs on the desktop client with local `--cwd` paths (same local-only
guard as inline edit). Selecting it replaces the list with a one-shot
streaming answer (`streamdown`) over the standard model with read-only tools
(`read`/`grep`/`find`/`ls`) across the project; the prompt names every worktree and
marks the currently selected one. Escape/Stop cancels the sidecar (`ai_ask_cancel`).

Default tab close/new and command-palette chords are native menu accelerators because
macOS/WebKit may consume them before webview listeners. `useShortcuts` defers those exact
default chords to native menu events to prevent duplicate actions; remapped chords remain
webview-handled. Xterm suppresses only legacy `keypress` Enter duplicates, never printable
keypress events needed for shifted input.

## Prompt Kanban board

A **project-scoped prompt board** lives behind the Kanban-icon button in the top tab
toolbar (`TerminalTabs`, between the usage-limits popover and the editor launcher; it
replaced the new-session button). `state/kanban-context.tsx` (`useKanban`) is mounted in
`App.tsx` **inside** `WorkspaceProvider` and is **always alive**, so it works in both
shell modes. It owns a `mode: "normal" | "kanban" | "settings"` switch: `WorkspaceShell` renders
`ProjectKanbanWorkspace` in place of the terminal `<section>` + right sidebar in Kanban
mode (the **sidebar stays**). Kanban **replaces** the shell rather than overlaying it —
native browser webviews (BrowserView) float above HTML, so an overlay would be clipped.
The automations UI is not a shell mode: it renders as the **Automations** section of the
full-frame Settings workspace (`AutomationsWorkspace embedded`), reachable via the native
Settings menu or `openSettings("automations")`.

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
