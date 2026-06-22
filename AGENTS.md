# Pragma — Agent & Contributor Guide

> This file is the single source of truth for how we build in this repo. `CLAUDE.md`
> is a symlink to it. Read it before making changes. Keep it up to date — if you
> change a pattern, change it here too.

## North star: clean, reusable, consistent

The overriding priority for this project is a **clean, reusable architecture** with
**consistent rules across TypeScript and Rust**. When you write code:

- **Reuse before you write.** Search for an existing helper, component, or constant
  first. Lift duplicated logic into a shared location the moment it appears twice.
- **Do not be afraid to create a new package or directory.** If something is shared,
  or _could_ be shared, give it a home (`packages/*`). If a value is referenced in
  more than one place, it belongs in `@pragma/constants`, not inline. Small,
  single-purpose packages are encouraged.
- **One source of truth.** Never copy a value across the TS/Rust boundary by hand —
  put it in `@pragma/constants` (see below).
- **Keep the two languages in lockstep.** The same concept should be named, layered,
  and error-handled the same way in TypeScript and Rust. See _Code standards_.
- **Suggest sweeping changes.** This project is early. If you see a cleaner structure,
  propose and make it — restructuring for clarity is welcome, not discouraged.

## Keeping this guide current (self-improvement)

**This document is living. If it is wrong, stale, or incomplete, fix it as part of your
change — that is expected, not optional.** A guide that drifts from reality is worse
than no guide.

- **Edit AGENTS.md in the same change that makes it outdated.** Add a package, move a
  file, change a command, bump a tool, adopt a new pattern → update the matching
  section (tech-stack table, repo map, commands, code standards) in the same commit.
  Because `CLAUDE.md` is a symlink to this file, both humans and agents stay in sync
  automatically.
- **Mirror it in the skills.** The `.agents/skills/*` files (symlinked to
  `.claude/skills/`) summarize parts of this guide. If you change a workflow here,
  update the relevant skill (`pragma-architecture`, `shared-constants`, `tauri-command`,
  `code-quality`) too, and add a new skill when you add a substantial new workflow.
- **When you discover something the hard way, write it down.** A non-obvious gotcha, a
  setup step, a "don't do X because Y" — capture it here so the next person (or agent)
  doesn't rediscover it.
- **Prefer fixing the guide over working around it.** If reality and this document
  disagree, decide which is correct: change the code to match the documented standard,
  or change the document to match the better reality — never leave them contradicting.
- **Keep it concise.** Prune advice that no longer applies. Length is not authority;
  accuracy is.

## Tech stack

| Concern          | Choice                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Monorepo / tasks | [Turborepo](https://turbo.build) + [Bun](https://bun.sh) workspaces                                                     |
| Desktop shell    | [Tauri v2](https://v2.tauri.app) (targets: **macOS + Linux only**)                                                      |
| Frontend         | [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript                                                   |
| Styling / UI     | [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) + `@tailwindcss/typography` (`prose`)   |
| Backend          | Rust (Tauri commands)                                                                                                   |
| GitHub           | Octokit (JS, in `lib/github.ts` only) + `reqwest` (Rust auth, `0600` token file); TipTap + react-markdown for PR bodies |
| Shared constants | JSON Schema → typed TS (`json-schema-to-typescript`) + Rust (`typify`)                                                  |
| SDK bundling     | [Bunup](https://bunup.dev) for dual ESM/CJS library output + `.d.ts`                                                    |
| Lint (TS)        | [oxlint](https://oxc.rs)                                                                                                |
| Format (TS)      | [oxfmt](https://oxc.rs)                                                                                                 |
| Lint (Rust)      | clippy (`-D warnings`, `all` + `pedantic`)                                                                              |
| Format (Rust)    | rustfmt                                                                                                                 |
| Tests            | Vitest (TS) + `cargo test` (Rust)                                                                                       |
| Commits          | Conventional Commits (commitlint)                                                                                       |
| Git hooks        | Husky + lint-staged                                                                                                     |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                                                                             |

## Repository structure

```
.
├── apps/
│   └── pragma/                  # The Tauri desktop app
│       ├── src/                 # React frontend (TypeScript)
│       │   ├── components/      # Workspace shell, sidebar, tab strip, dialogs, terminal host
│       │   ├── components/ui/   # shadcn/ui primitives (generated; avoid hand-edits)
│       │   ├── lib/             # Reusable, framework-agnostic helpers
│       │   │   ├── tauri.ts     # Typed bridge to Rust commands — the ONLY place invoke() is called
│       │   │   ├── terminal-manager.ts # Non-React xterm registry; terminal output bypasses React state
│       │   │   ├── native-editing.ts # OS text-editing chords → readline sequences; text-context detection
│       │   │   └── utils.ts     # cn() + small utilities
│       │   ├── hooks/           # React hooks (use-shortcuts: keybindings; use-escape-to-close: modal dismiss)
│       │   ├── state/           # Workspace context/reducer for projects/worktrees/tabs only
│       │   ├── test/setup.ts    # Vitest setup
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── src-tauri/           # Rust backend
│           ├── src/lib.rs       # App wiring, managed state, plugins, command registration
│           ├── src/db.rs        # SQLite migrations + typed CRUD
│           ├── src/pty.rs       # Detached daemon client + PTY command proxying
│           ├── src/git.rs       # Git CLI helpers (worktree_changes / worktrees_merged_status / file_diff / stage_* / discard_*)
│           ├── src/github.rs    # GitHub auth (0600 token file, OAuth device flow, gh CLI) + worktree-scoped git for PRs
│           ├── src/fs.rs        # Worktree-scoped, path-safe filesystem commands
│           ├── src/main.rs      # Thin entrypoint
│           ├── tauri.conf.json  # Window/bundle config (mirror values from @pragma/constants); bundles pragma-daemon via externalBin
│           ├── tauri.dev.conf.json # Dev overrides ("Pragma Dev" name/title + icons-dev/) merged via `tauri dev --config`
│           ├── scripts/         # Build helpers (stage-daemon-sidecar.sh — builds + stages the daemon sidecar)
│           ├── binaries/        # Staged `pragma-daemon-<triple>` Tauri sidecar (git-ignored; built, never committed)
│           ├── icons/           # Production app icons
│           └── icons-dev/       # Dev "Pragma Dev" app icons (generated via `tauri icon`)
├── crates/
│   ├── pragma-agent-cli/        # `pragma-agent` helper CLI for external agents to report runtime status
│   ├── pragma-daemon/           # Detached Unix-socket PTY daemon; owns shell sessions + scrollback
│   └── pragma-protocol/         # Shared daemon wire frames/framing used by daemon, app, and CLI
├── packages/
│   ├── constants/               # Dual TS + Rust package — shared source of truth
│   │   ├── schema.json          # JSON Schema (the contract). EDIT THIS to change shape.
│   │   ├── values.json          # The actual values. EDIT THIS to change values.
│   │   ├── src/index.ts         # Typed TS export
│   │   ├── src/lib.rs           # Rust export (typify-generated types + parsed values)
│   │   └── src/generated/       # Generated TS types (git-ignored; never edit)
│   ├── sdk/                     # `@pragma/sdk` typed Node/Bun wrapper around `pragma-agent`
│   └── opencode-plugin/         # `@pragma/opencode-plugin` ESM opencode plugin + bundled Pragma agent config
├── tsconfig.base.json           # Shared strict TS config (every package extends it)
├── Cargo.toml                   # Rust workspace (shared deps + lints + release profile)
├── rustfmt.toml                 # Rust formatting rules
├── turbo.json                   # Task graph
├── commitlint.config.js         # Conventional Commits rules
├── .oxlintrc.json / .oxfmtrc.json
├── .husky/                      # Git hooks
└── .agents/skills/              # Agent skills (symlinked to .claude/skills)
```

**Where things go:**

- A value used by both frontend and backend → `packages/constants` (`values.json`).
- A value/helper used by multiple frontend modules → `apps/pragma/src/lib/`.
- A helper/type that could be reused by a future app → a new `packages/*` package.
- A typed JS wrapper over the bundled agent CLI → `packages/sdk` (`@pragma/sdk`).
- A reusable UI primitive → `apps/pragma/src/components/ui/` (prefer `shadcn add`).
- Anything that calls the Rust backend → `apps/pragma/src/lib/tauri.ts` (never call
  `invoke()` directly from components).
- **GitHub REST/GraphQL → `apps/pragma/src/lib/github.ts`, the ONLY place `new
Octokit()` happens** — the exact same discipline as the `invoke()` rule, because
  Octokit is a JS-only SDK we can't push into Rust. Components import the typed
  helpers (`findPullRequestForBranch`, `createPullRequest`, `getChecksStatus`,
  `listReviewThreads`/`resolveReviewThread`/`unresolveReviewThread` via `.graphql()`, …); they never build a
  client. The client is lazily built from the stored token (`githubToken()`) and
  cached by token, so sign-in/out rebuilds it (`resetGitHubClient`). Everything
  **secret/OS/git** stays in Rust (`src-tauri/src/github.rs`): the token is stored in
  a **`0600` plaintext file** under the app data dir (`github-token`, owned by the
  managed `TokenStore`) — the same model the `gh` CLI uses, and **never SQLite**. The
  OS keychain is deliberately **not** used: keychain items are scoped to the app's
  code signature, so unsigned/dev builds (a fresh ad-hoc signature on every rebuild)
  re-prompt for keychain access on every launch. The plaintext file has no
  signature check, so there is no prompt. Also in Rust:
  OAuth **Device Flow** polling (`reqwest` blocking, no client secret/PKCE), `gh` CLI
  detection/adoption, `origin`→`owner/repo`, fetch+ahead/behind, push, the local
  `base...HEAD` PR file diff, and remote-branch delete. The `oauthClientId`, scopes,
  and endpoint URLs are in `@pragma/constants` (`github` block); the setup-skip flag
  persists in the `settings` table (`github.setupDismissed`). Auth state is held by
  `state/github-context.tsx` (`useGitHub`) and gates both the full-screen
  `GitHubSetupModal` and the **Pull Request** right-sidebar subtab; the two share one
  reusable `<GitHubAuthOptions />` (DRY). The PR subtab (`right-sidebar/PullRequestTab`)
  resolves logged-out → create (`CreatePullRequestView`, TipTap markdown editor +
  behind-blocks / dirty-warns pre-flight) → view (`ViewPullRequestView`, header +
  read-only comments + files-changed reusing `ChangeGroup` + merge→branch-cleanup).
  A PR review opens a `pr-review` `TabKind` (v7 `pr_number` column) rendered through
  `SplitHost` (`github/ReviewTab`): per-file done-toggle (ephemeral
  `state/review-done-store.ts`, like `editor-dirty-store`), side-by-side diff via the
  shared `editor/MergeDiff` (extracted from `DiffView`, fed by `github_pr_file_diff`),
  and inline thread resolve/unresolve. The resolve/unresolve toggle is
  **optimistic**: `ReviewThreadCard` flips the thread in `ReviewTab`'s state in place
  (via a `setThreadResolved` updater that clones only the affected path's bucket) and
  fires the GraphQL mutation in the background, reverting + toasting **only on
  failure** — it never refetches the whole tab (that flashed the diff panes).
  `MergeDiff` gives both panes a **line-number gutter** and
  **syntax highlighting** (custom dark `pragmaHighlightStyle` in
  `editor/codemirror-theme.ts` over `@lezer/highlight` tags; the grammar is detected
  from the file name via `@codemirror/language-data` and loaded lazily into a
  `Compartment`). It also takes an optional `comments: DiffComment[]` and mounts each as
  a **block widget beneath its anchor line on the new (right) side** via a React portal —
  so `ReviewTab` renders line-anchored review threads inline next to the code (line-less
  file-level threads still list beneath the diff). Markdown is rendered read-only via `react-markdown` +
  `remark-gfm` (`github/GitHubMarkdown`). The `simple-icons:github` glyph is bundled
  offline through `brand-icons.json` (lucide-react dropped its brand `Github` export).
- PTY/session business logic → `crates/pragma-daemon`; shared wire framing/types →
  `crates/pragma-protocol`; agent status CLI → `crates/pragma-agent-cli`. The Tauri app only proxies over
  the Unix socket and must not own PTYs.
- **Agent connector.** External agents running inside a Pragma terminal report status by
  calling `pragma-agent --agent <id> report started|stopped|attention|cleared`. `started` →
  `running` (yellow), `stopped` → `done` (green, "finished, go look"), `attention` → red, and
  `cleared` **removes** the tab's indicator entirely (used when the agent process exits, so a quit
  agent leaves no leftover green dot — distinct from `done`). Terminal spawns inject
  `PRAGMA_TAB_ID` (same value as the daemon session id / tab id), `PRAGMA_WORKTREE_ID`, and
  `PRAGMA_DAEMON_SOCKET`; the CLI uses only those env vars to connect to the existing daemon
  socket, read the `Hello`, write one `AgentReport` frame, and exit without waiting for an ack.
  The daemon keeps runtime-only status in memory keyed by `(worktreeId, tabId, agent)`, supports a
  long-lived `SubscribeAgents` request for the app, emits `EventFrame::Agent` snapshots/events, and
  clears a tab's snapshot entries when the session exits. It also supports a `MarkAgentsSeen` request
  (`mark_agents_seen_for_tab`) that drops a tab's **`done`** entries (leaving `running`/`attention`)
  once the user has viewed the tab — see below. Status is never persisted to SQLite; the
  frontend stores it in `state/agent-status-store.ts` via `useSyncExternalStore`, renders the current
  runtime state in tab/sidebar dots (`done` = green, `running` = yellow, `attention` = red) with
  precedence **red > yellow > green** when aggregating a tab's agents or a worktree's tabs. Green is a
  "finished, go look" notification: `running`/`attention` persist through a focus, but viewing a tab
  clears its `done` entries from the store (`clearDoneStatusForTab`) **and tells the daemon to drop the
  stored `done`** (`markAgentsSeen`, the `MarkAgentsSeen` request) — both when the tab becomes the
  on-screen tab (`visibleTabIds` effect) and when a `done` report arrives for an already-visible tab —
  so the worktree dot stops being green once every finished tab in it has been seen, **and a later
  daemon reconnect/snapshot replay can no longer resurrect that green dot or re-fire its
  notification** (the daemon no longer stores the seen `done`). Closing a tab drops all of its status
  (`removeAgentStatusForTab`).
  **Alerts (chime + system notification) are gated by a latch separate from the dot store, not by the
  store's previous value.** The daemon keeps a `done`/`attention` until the agent moves on (or, for
  `done`, until the app marks it seen) and **replays its whole status snapshot on every reconnect**
  (`agent_events.rs` re-subscribes on any disconnect, re-emitting `pragma:agent-status-reset` + the
  full snapshot). Viewing a tab drops the daemon's stored **`done`** via `markAgentsSeen` (so a
  reconnect won't replay a finished-and-seen completion), but **`attention` is never marked seen** — it
  stays in the daemon until the agent resolves it — and a `done`/`attention` can also be alerted-but-
  not-yet-viewed when a reconnect lands first. So gating "is this a new alert?" on the store's previous
  status would re-fire on every reconnect (the reset wipes the store, making each replayed status look
  new). Instead `lib/agent-alert.ts` keeps an `alertedStatusByKey` latch keyed by worktree+tab+agent:
  a `done`/`attention` alerts at most once (`shouldAlertForStatus` + `latchAlertedStatus`), the latch
  is **released only when the agent genuinely moves on** — a `running` or `cleared` report
  (`releaseAlertLatch`) — and dropped on tab close (`releaseAlertLatchForTab`). A snapshot replay thus
  restores the dots without re-notifying. **Viewing a tab latches every `done`/`attention` status it
  currently shows as seen**, so a later replay never re-fires for it: the report handler latches a
  `done`/`attention` that arrives while the tab is already visible, and the `visibleTabIds` effect
  reads `agentStatusesForTab` and latches them (before `clearDoneStatusForTab`) when a tab comes on
  screen. Without this an `attention` (pending permission) that arrived while you were watching the tab
  was never latched, so leaving the tab and a later reconnect re-fired the "needs attention"
  notification the user had already seen.
  Agent pins are cosmetic localStorage state in `state/agent-pins.ts`. `daemon.protocolVersion` is **6** for
  this protocol (the `MarkAgentsSeen` request is the latest wire change; the `cleared` `AgentStatus`
  was an earlier one). On the daemon a `cleared` report
  **removes** the `(worktreeId, tabId, agent)` entry from its in-memory map and broadcasts the cleared
  event so live subscribers drop the indicator and a reconnecting subscriber's snapshot omits it;
  the frontend store (`applyAgentReport`) deletes the agent entry on `cleared` rather than storing it. Agent launcher configs live in `~/.pragma/agents/<id>/config.json` with fields
  `id`, `name`, `icon`, and `start` (string or argv array); icons must resolve inside that agent
  directory. Bundled/default agent configs live in package-owned `pragma/agents/*/config.json`
  folders (currently `packages/opencode-plugin/pragma/agents/opencode/config.json`), are staged to
  `apps/pragma/src-tauri/resources/pragma/agents` by `src-tauri/scripts/stage-daemon-sidecar.sh`,
  bundled as Tauri resources, and installed/updated into `~/.pragma/agents` on app startup. The app
  installs/updates the bundled `pragma-agent` into `~/.local/bin` on startup and emits a UI warning
  if that directory is not on `$PATH`. JS/TS consumers should use `@pragma/sdk` (`packages/sdk`)
  instead of hand-building `pragma-agent` argv; it shells out to the installed CLI with typed
  options and is bundled by Bunup as ESM, CJS, and `.d.ts`. opencode integration lives in
  `@pragma/opencode-plugin` (`packages/opencode-plugin`): an ESM-only Bunup package that imports
  opencode plugin types from `@opencode-ai/plugin`, reacts to opencode hooks/events, and reports
  `started` / `stopped` / `attention` / `cleared` through `@pragma/sdk` without asking the LLM to call any CLI.
  `hooks.ts` is a **two-flag state machine** (`busy`, `attention`) rather than a per-event mapping:
  the reported status is _derived_ (`attention` > `busy` > idle) and emitted only on change, so a
  trailing `message.*` stream event can't clobber green back to yellow and a pending question/permission
  pins red even while opencode reports the session idle. `busy` is set by `chat.message`,
  `command.execute.before`, non-question `tool.execute.before`, and `session.status` busy/retry;
  cleared by `session.idle` / `session.status` idle / a non-abort `session.error` / `session.deleted`.
  **`stopped` (the green "finished, go look" `done`) is only emitted after a `started`** — a bare
  `session.idle`, or the idle that may trail an aborted/cleared turn, must not resurrect a phantom
  "finished" dot/notification. **An aborted turn (esc-esc / `session.abort`) surfaces as a
  `session.error` carrying `MessageAbortedError` and reports `cleared`, not `stopped`** (there is no
  result to look at, so the indicator resets). **`server.instance.disposed` also reports `cleared`** —
  opencode quitting clears the dot even when the `dispose` plugin hook doesn't run (an abrupt
  shutdown). `attention`
  is raised by the **`permission.asked`** event (command) and the `question` tool (via
  `tool.execute.before` or a pending `message.part.updated` part), and cleared by `permission.replied`
  or the question part completing/erroring. **Permission events — verified empirically against the
  opencode binary, because the published `@opencode-ai/sdk` types are wrong here:** the runtime emits
  `permission.asked` / `permission.replied` (NOT the `permission.updated` the TS `Event` union
  declares), and it **never calls the `permission.ask` plugin hook** (the hook key is absent from the
  binary). The plugin `event` hook does receive `permission.asked` (confirmed by running opencode with
  a logging plugin), which is why event-based detection works and the dead `permission.ask` hook does
  not. The legacy `permission.ask` hook + `permission.updated` event are kept only as harmless
  cross-version fallbacks; the live path is `permission.asked`. Only real opencode events are handled —
  do **not** re-add the speculative `session.next.*` events (opencode does emit
  `session.next.agent.switched` / `session.next.model.switched`, but they carry no status meaning and
  the default branch ignores them; mapping them was the source of the stuck-yellow bug). **`dispose`
  (the agent process exiting) reports `cleared`, not `stopped`** — quitting opencode removes the
  indicator instead of leaving a green "done" dot; finishing a turn (`session.idle`) still reports
  `done`. **On load (`PragmaOpencodePlugin` in `index.ts`) the plugin fires one `cleared` up front** so
  opening opencode never inherits a stale indicator from a previous run in the same tab that exited
  without cleanup: `dispose` only runs on a graceful quit, so a SIGINT/crash leaves the last
  `running`/`done`/`attention` lingering in the long-lived daemon, and the next open would otherwise
  show it. Clearing on init wipes that; genuine activity re-raises status via the hooks (verified
  empirically: a bare TUI open emits no busy/idle/chat events, so after the init `cleared` the tab
  shows nothing until the first `chat.message`). The SDK reporter in `index.ts` no longer dedups; it
  only guards on the Pragma env and shells out.
  The plugin build is staged as `resources/pragma/plugins/opencode.mjs`; on startup the app
  (`src-tauri/src/opencode_plugin.rs`) copies it to `~/.config/opencode/plugins/opencode.mjs` **and
  registers that absolute path in the `plugin` array of `~/.config/opencode/opencode.json`**.
  **opencode does NOT auto-load plugins from any directory** — verified empirically against opencode
  1.17.8, a file dropped in `~/.config/opencode/plugins/` (or a project `.opencode/plugin/`) is never
  loaded; the only mechanism that loads a plugin is a `plugin`-array entry. A **file path / `file://`
  URL** entry loads fine and is **not** npm-resolved; only the **bare package name**
  `@pragma/opencode-plugin` is treated as an npm dependency (opencode tries to install it from the
  public registry, where it does not exist), so never register it by name. The directory under
  `plugins/` is therefore just Pragma's storage location, not an opencode scan dir. `ensure_installed`
  is idempotent and removes stale Pragma entries (the bare npm name, or any prior `opencode.mjs` path /
  `file://` URL pointing elsewhere) before re-adding the current absolute path; an unparseable config
  is backed up to `opencode.json.pragma-bak` and left untouched.
  macOS agent system notifications are clickable: the frontend calls the macOS-only
  `show_agent_notification` Tauri command instead of the generic notification plugin (which exposes no
  desktop click event), and Rust emits `pragma:agent-notification-clicked` with `{ projectId,
worktreeId, tabId }`; `workspace-context` routes that through `navigateToAgentLocation` so clicking
  the notification opens the correct worktree/tab. Non-macOS falls back to the regular plugin
  notification.
- **The daemon coalesces PTY output to cut the per-frame transport/render cost.** The
  PTY master is read in 64 KB chunks (`READ_BUFFER_BYTES`) so a full-grid TUI redraw
  arrives as one read instead of many; a dedicated coalescer thread
  (`Session::start_coalescer` in `crates/pragma-daemon/src/session.rs`) then merges
  consecutive `Output` into a single broadcast frame on a **trailing throttle**
  (`OUTPUT_COALESCE_INTERVAL`, 8 ms): the first output after an idle gap flushes
  immediately (zero added keystroke-echo latency), and only back-to-back output is
  batched — flushed at most once per interval, or sooner at `OUTPUT_COALESCE_MAX_BYTES`
  (256 KB). This collapses a scroll/redraw flood into far fewer socket
  frames, Tauri IPC messages, and xterm parse/paint passes (each redraw is otherwise
  amplified: tiny scroll input → whole-grid repaint on the return trip). `Title`/`Exit`
  flush pending output first so ordering is preserved. The reader thread now only
  strips OSC titles and hands `OutputMsg`s to the coalescer over an mpsc channel. This is
  PTY-stream handling, so changing the coalescing/buffering still requires bumping
  `daemon.protocolVersion` (below).
- **Terminal output is shipped as raw bytes end-to-end — never JSON.** The wire protocol
  (`crates/pragma-protocol`, consumed by the daemon, Tauri app, and `pragma-agent`) is
  **tag-prefixed**: every frame is
  `[4-byte BE length][1-byte tag][body]`. Tag 0 = JSON control frame (hello, requests,
  responses, title/exit events); tag 1 = a binary **output** frame whose body is
  `[2-byte BE session-id length][session id][raw output bytes]` (`write_output_frame` /
  `Frame::Output`). Output therefore crosses the socket without JSON escaping (which
  expands each `0x1B` ~6x) and **without any UTF-8 decode** — `EventFrame::Output` holds
  `Vec<u8>`, there is no `Utf8Carry`, and xterm reassembles any multi-byte sequence split
  across frames itself. The app→webview hop is binary too: the PTY `Channel` is
  `Channel<InvokeResponseBody>`, output is forwarded as `InvokeResponseBody::Raw` (the app
  never re-encodes it — it relays the daemon's bytes straight through), which the JS
  `Channel.onmessage` receives as an **`ArrayBuffer`**; title/exit go as
  `InvokeResponseBody::Json` and arrive as objects. `terminal-manager.ts` branches on
  `message instanceof ArrayBuffer`, queues `Uint8Array`s in `pendingOutput`, and feeds
  `terminal.write(Uint8Array)` directly (xterm accepts bytes), so output never becomes a JS
  string on the hot path. Any change to the frame layout, the tag values, or the channel
  payload types **must** be applied to both the daemon and the app copy and bump
  `daemon.protocolVersion` (below).
- **The daemon is detached and long-lived**, so a rebuild does **not** restart it — a
  stale daemon keeps serving over the existing socket and your new daemon code never
  runs. A protocol-version handshake guards against this: the daemon greets every
  connection with a `ServerFrame::Hello { protocolVersion }` (first frame, always) and
  records its PID in `daemon.lock`; the app's `connect_compatible` (`src-tauri/src/pty.rs`)
  reads that hello and, on a version mismatch **or no greeting** (an old pre-handshake
  daemon), kills the stale process (by lock-file PID, falling back to `pkill`) and respawns
  a matching one. The version is the shared `@pragma/constants` `daemon.protocolVersion` —
  **bump it whenever you change the daemon wire protocol or its PTY-stream handling** (e.g.
  the OSC title parser) so existing daemons are replaced instead of silently serving old
  behavior. The value is read by both the daemon and the app crates from
  `pragma_constants::CONSTANTS.daemon.protocol_version`.
- **The daemon ships as a Tauri sidecar so prod is self-contained.** A release app
  launches `pragma-daemon` from **beside its own executable** (`daemon_executable()` in
  `src-tauri/src/pty.rs` = `current_exe().parent()/pragma-daemon`); a debug app spawns it
  via `cargo run -p pragma-daemon` instead. The release binary gets there because
  `tauri.conf.json` declares `bundle.externalBin: ["binaries/pragma-daemon"]`, and the
  Tauri CLI copies (and code-signs) `src-tauri/binaries/pragma-daemon-<target-triple>` next
  to the app binary in every bundle. That sidecar is **built, not committed** — staged by
  `src-tauri/scripts/stage-daemon-sidecar.sh` (`cargo build -p pragma-daemon` + copy with
  the host triple), wired in two places: `tauri:build`'s `beforeBuildCommand` runs it
  `--release`, and `tauri:dev` runs it (debug) before `tauri dev` so the CLI's sidecar-copy
  step doesn't fail (dev still uses `cargo run` at runtime — the staged file only satisfies
  bundling). The daemon is spawned directly with `std::process::Command`, **not** the shell
  plugin, so no `shell:` capability is needed. `pragma-agent` and the opencode plugin dist are
  staged by the same script and bundled as `binaries/pragma-agent` plus
  `resources/pragma/plugins/opencode.mjs`. `binaries/` is git-ignored.
- **Dev, prod, and every dev worktree are fully isolated by an instance "channel".**
  One channel scopes **both** the daemon (socket/lock/log) **and** the per-instance data
  dir (`pragma.db` + the GitHub token file), so a dev build can never attach to prod's
  daemon nor read/corrupt prod's database — and **two worktree dev builds never collide
  with each other**, which was the source of the dev-stability/version-conflict problems.
  The channel is chosen from the build's **product identity, not the compile profile**:
  `instance_channel` in `src-tauri/src/pty.rs` returns the stable `pragma` for a production
  build ("Pragma"), and `pragma-dev-<hash>` for a dev build ("Pragma Dev", set in
  `tauri.dev.conf.json`) where `<hash>` is `pragma_protocol::dev_channel(workspace_root)` —
  a deterministic hash of the **absolute workspace root the binary was compiled in**. Two
  worktree checkouts sit at different paths, so they hash to different channels; the same
  worktree is stable across rebuilds. Product identity (not `cfg!(debug_assertions)`) is
  deliberate — a **release-built dev app** (e.g. when profiling terminal latency) is still a
  dev app and must keep its own per-worktree instance. `PROD_CHANNEL` + `dev_channel` live in
  `pragma-protocol` (the one crate both the app and daemon share) so both compute identical
  channels.
  - **Data dir:** `instance_data_dir(app_data_dir, channel)` returns the legacy app-data root
    **verbatim for prod** (so an existing install's `pragma.db`/token are never relocated) and
    `app_data_dir/<channel>` for a dev build. `lib.rs` `setup_app` resolves the channel once,
    opens the DB and `TokenStore` under that dir, and passes the channel to `PtyClient::new`.
  - **Daemon dir:** the same channel; on Linux it's `$XDG_RUNTIME_DIR/<channel>`, elsewhere
    `<app_data_dir>/<channel>` (so in dev the daemon socket sits right next to that worktree's
    `pragma.db`). The app hands the channel to the spawned daemon via the **`PRAGMA_DAEMON_CHANNEL`
    env** alongside `PRAGMA_APP_DATA_DIR`; `crates/pragma-daemon/src/main.rs`
    (`daemon_channel` → `daemon_paths`) reads that env, falling back to `default_daemon_channel`
    (the same `dev_channel(workspace_root)` for a debug build, `PROD_CHANNEL` for release) only
    when the daemon is run by hand — so a manual `cargo run -p pragma-daemon` in a worktree
    serves that worktree's app.
    NB this isolates Pragma's **own** state (daemon + DB + token). Both builds still share the
    Tauri `identifier` (`com.pragma.app`) and user config under `~/.pragma` / `~/.config/opencode`;
    give the dev build its own `identifier` only if you need to split the OS-level app-data root too.
- **Native menubar + the Troubleshooting menu.** The app menu is built once in
  `src-tauri/src/lib.rs` `install_menu` — `Menu::default(app)` (so the OS-standard
  app/edit/window items survive) **plus** a `Troubleshooting` submenu with **Restart
  Daemon** and **Open Daemon Logs**. Menu clicks are pure forwarders: `on_menu_event`
  re-emits the item id as the `pragma:menu` Tauri event (payload = the menu id), and the
  frontend (`workspace-context`, via `onMenuAction` in `lib/tauri.ts`) runs the action so
  feedback lives in the UI — **Restart Daemon** calls the `restart_daemon` command
  (`PtyClient::restart` = kill the running daemon, respawn, confirm reachable; this
  terminates every shell) with a `sonner` toast, and **Open Daemon Logs** opens the
  `log` tab. Add a menu action by giving it an id const + item in `install_menu`, a
  `MenuAction` variant + branch in `handleMenuAction`. The daemon log itself isn't
  worktree-scoped, so it loads through the dedicated `read_daemon_log` command
  (`PtyClient::read_log`, reading `log_path()` — the `daemon.log` beside the socket, which
  on Linux is the XDG runtime dir, **not** app data) rather than the worktree file editor.
- Terminal output → xterm in `src/lib/terminal-manager.ts`; never route it through
  React state or the workspace reducer. Each terminal renders through the **WebGL
  addon** (`@xterm/addon-webgl`), loaded right after `terminal.open()` (the renderer
  needs the canvas to exist first) — xterm's default DOM renderer reflows real DOM
  nodes per frame and is the dominant source of perceived typing latency. Loading is
  wrapped in `try/catch` and `onContextLoss` disposes the addon, so a missing or lost
  WebGL2 context (headless CI, driver reset) transparently falls back to the DOM
  renderer instead of freezing. Frontend output writes are serialized through xterm's
  write callback (`pendingOutput` / `writeInFlight`) so a burst of daemon chunks coalesces
  behind the in-flight parser/render pass instead of enqueueing unbounded `terminal.write`
  calls when rendering slows. The xterm scrollback is bounded to 500 lines
  (`TERMINAL_SCROLLBACK_LINES`) so long sessions and manual scrollback do not keep growing
  renderer state. **Keystroke input is fire-and-forget and
  pipelined**: `onData` fires `ptyWrite` without awaiting (JS side), and on the
  Rust side `pty_write` runs inline (no `spawn_blocking`) and only _enqueues_ onto
  a dedicated writer thread (`input_tx` / `start_input_writer` in
  `src-tauri/src/pty.rs`) that owns its own daemon connection. Writes do **not**
  wait for the daemon's per-write `Response` (a companion `discard_frames` thread
  drains them so the socket buffer can't fill), so consecutive keystrokes pipeline
  instead of each one stalling behind the previous keystroke's full daemon
  round-trip. `resize`/`kill` keep the separate pooled, handshake-free
  request/response connection (`request_conn`). **Native OS text-editing chords**
  (macOS Cmd+Backspace/Left/Right, Option+Left/Right/Backspace; Linux
  Ctrl+Left/Right/Backspace/Delete) are translated to readline control characters
  by `nativeEditingSequence` in `lib/native-editing.ts` inside xterm's
  `attachCustomKeyEventHandler`, checked **before** configured Pragma shortcuts so
  Cmd+Backspace deletes the line (Ctrl+U) in the terminal instead of bubbling up
  to `deleteFile`. Shift-modified variants are left alone so xterm's own
  shift-selection keeps working. **Shift+Enter is rewritten to ESC+CR** in the
  same `attachCustomKeyEventHandler` (also checked before the keybinding
  passthrough) so TUI REPLs (Claude Code, opencode, Codex) insert a soft newline
  instead of submitting. xterm only maps Enter to CR, so a bare Shift+Enter would
  otherwise be indistinguishable from Enter; swallowing the event and writing
  `\x1b\r` makes the shift meaningful without affecting plain Enter or
  Cmd/Ctrl/Alt+Enter (which still fall through to xterm / configured keybindings).
  For a shell that ignores the ESC, the trailing CR still ends the line — at
  worst Shift+Enter behaves like Enter. The remaining echo latency is
  structural — every character still crosses two webview↔native IPC boundaries
  plus a socket hop to the detached daemon, where an in-process terminal would
  echo via direct calls. Fitted terminal grids are capped at 240×90 cells
  (`MAX_TERMINAL_COLS` / `MAX_TERMINAL_ROWS`) before both xterm resize and PTY
  resize; fullscreen TUIs tend to redraw the entire grid per interaction, so letting
  huge monitors produce unbounded rows/cols regresses the latency gains above.
  TUI mouse-report input is forwarded exactly as xterm emits it so mouse-tracking
  TUIs like opencode can intercept wheel events. Do not batch or rewrite mouse
  reports, and do not override xterm wheel sensitivity unless the TUI interception
  path is re-tested. **Wheel reports are rate-limited, not rewritten, while a TUI
  has mouse tracking on.** xterm emits one mouse report per OS wheel event, and
  macOS momentum trackpad scrolling fires 100+ events/s; a mouse-tracking TUI
  redraws its whole grid per report and consumes reports no faster than it can
  redraw, so the unthrottled flood backs the PTY input up — scrolling keeps going
  after your finger stops (a laggy, floaty tail) and the render backlog can make it
  freeze. An `attachCustomWheelEventHandler` in `terminal-manager.ts` drops (returns
  `false` for) wheel events that arrive within `MOUSE_WHEEL_REPORT_INTERVAL_MS` of
  the last forwarded one, but **only when `terminal.modes.mouseTrackingMode !==
"none"`** — with mouse tracking off, xterm scrolls its own viewport locally and is
  left untouched so normal scrollback stays smooth. This interval is the scroll-feel
  knob (lower = faster/farther scroll but more redraw load; higher = calmer but a
  flick scrolls less); tune it rather than removing the throttle or rewriting reports.
- **Shell-driven tab titles.** The daemon parses OSC 0 / OSC 2 (`ESC ]0/2;…BEL/ST`)
  out of the raw PTY stream in `crates/pragma-daemon/src/session.rs` and emits a
  `Title` event. The Tauri proxy in `apps/pragma/src-tauri/src/pty.rs` forwards it
  as `PtyEvent::Title`, the non-React `TerminalManager` fans it out via
  `onTitle(tabId, listener)`, and the workspace context dispatches the
  `set-auto-title` reducer action. `Tab.userRenamed` is the single guard: the user
  flipping it via double-click/context menu (the existing `rename-tab` action +
  `rename_tab` Tauri command, which now also sets `user_renamed = 1` server-side)
  permanently locks the tab's title against any future shell push. The browser-meta
  pipeline (page `<title>` updates) takes the same `set-auto-title` route so a
  stray browser title can never flip the flag either.
- **HTML5 drag-and-drop requires `"dragDropEnabled": false`** on the window in
  `tauri.conf.json`. It defaults to `true`, which makes Tauri capture OS drag/drop at the
  native level and the in-page `dragstart`/`dragover`/`drop` events never fire. Also note
  WebKit withholds `dataTransfer` payloads until the `drop` event, so the dragged tab id
  is tracked in shared React state (`components/tabs/tab-drag-context.tsx`), not read back
  out of `dataTransfer` during `dragover`.
- Native browser webviews (`BrowserView`) float **above** all HTML, so an HTML overlay
  can't sit on top of them and drop events never reach a pane showing a browser tab. The
  shared `isDragging` signal hides the native overlays for the duration of a drag so the
  drop zones underneath become reachable; drop-zone geometry lives in
  `components/tabs/tab-drag.ts`. For the same reason, any HTML overlay that opens **over**
  a browser pane (dropdown menu, popover) would be clipped by the native webview, so the
  shadcn `DropdownMenu`/`Popover` roots register with the ref-counted suppression store in
  `lib/native-overlay.ts` while open; `BrowserView` steps its webview aside whenever
  `useNativeOverlaySuppressed()` is true. Because the OS can't composite HTML over a live
  child webview in a sub-region, "stepping aside" means hiding it — but for a menu/popover
  `BrowserView` first captures a still of the live page (`browser_snapshot` → a PNG data
  URL via the same `xcap` region grab as `browser_screenshot`) and paints it in the
  placeholder, so the pane looks unchanged behind the overlay; the snapshot is dropped and
  the live webview restored on close. (A drag instead collapses bounds to zero and shows no
  snapshot — the pane must be a free HTML drop target, not a frozen page.) New floating UI
  built on those two primitives gets this for free; anything else that must paint above a
  browser must wrap its open window in `useSuppressNativeOverlayWhile(open)`.
- **Split / tab-bar model:** there is one `splitRootByWorktree` layout per worktree. Tabs
  inside a real split are "split members"; every other tab is a "normal" top-bar tab. The
  top strip (`TerminalTabs`) shows the normal tabs **plus a single parent tab** that stands
  in for the whole split, named after its top-left pane (`leadingPane`); the split's own
  members are hidden from the top strip and live in the per-pane bars (`SplitHost`'s
  `PaneBar`, shown for every pane). Splitting from the un-split state pulls only the
  **active** tab into the new group (the rest stay normal); `normalizeRoot` only folds new
  tabs into a single-pane root, never into a real split. Dropping a tab anywhere on a pane's
  **content** always splits — the pane is divided into four quadrants by its diagonals and the
  pointer's quadrant picks the split side (`dropTargetAt`; there is no merge/center zone). To
  move a tab **into** a pane (stack it) instead, drop it on that pane's **tab bar**. Each `PaneBar` has its
  own "+" menu that creates a new tab **inside that pane** (`createTabInPane` →
  `add-tab-to-pane`); the top strip's "+" and the `⌘T`/`⌘B` shortcuts always add **normal
  top-level** tabs, never split members.
- **Split layouts persist in SQLite** (the `splits` table, v4 migration — one row per
  worktree keyed by `worktree_id`, cascade-deleted with the worktree). The layout is an
  **opaque JSON blob owned entirely by the frontend** (`SplitLayoutNode`); Rust stores and
  returns the string verbatim via `list_splits` / `set_split_layout` / `clear_split_layout`
  (no `@pragma/constants` shape — the backend never parses it). On project load the
  workspace dispatches `set-splits` (after `set-tabs`) to merge stored layouts, reconciled
  against the current tabs. An effect in `workspace-context.tsx` persists on every change:
  only **real splits** (`root.kind === "split"`) are written; a worktree that collapses
  back to a single pane clears its row. `rootsForTabs` must **not** drop roots for worktrees
  outside the loaded project's tab snapshot — that both lost splits on project switch and
  would make the persist effect erase them. Restored node ids are passed through
  `reserveSplitNodeIds` so the regenerated `pane-N`/`split-N` counter never collides.
- **Files & Changes right sidebar + editor/diff tabs.** A right sidebar (mirroring the left
  `ProjectSidebar`) lives in `components/right-sidebar/` and is the last flex child of
  `WorkspaceShell` (so collapsing it reflows the center pane and the `BrowserView`
  ResizeObserver re-applies native bounds for free). Its cosmetic state (collapsed / active
  subtab / width) lives in `state/right-sidebar-context.tsx` and persists to **localStorage**,
  not SQLite. Two subtabs: **Files** (lazy `FileTree`, inline create + inline rename) and
  **Changes** (three git lists — **Staged**, **Unstaged**, **Committed**, in that order). The
  **Files** subtab mirrors the worktree-tree rename UX: right-click any row → **Rename** (works
  for files and folders; replaces the row's label with `<RenameEntryInput>`, which pre-fills
  the current name, selects the basename — leaving the extension unselected for files — and
  commits on Enter / cancels on Escape). The input caps at `max-w-[14rem]` and disables
  `autoCapitalize` / `textTransform` so long names don't push the icon and the typed value
  isn't transformed. The controller's `renameMode` lives in `FilesTab` alongside `createMode`,
  and `commitRename` calls `renameFile(worktreeId, from, to)` then bumps the parent's nonce
  (and the destination parent's nonce for cross-directory moves). On the backend,
  `fs::rename_file` resolves both paths through `resolve_in_worktree`, refuses to overwrite an
  existing destination (`InvalidInput`), and uses `std::fs::rename` so it works for files _and_
  directories and is atomic on the same FS. **Selection + delete**: a single click on a file
  selects it (a `selectedFile` path on the controller, rendered with an `outline outline-1
outline-cyan-400/60` ring so it's distinguishable from the `bg-white/10` "active directory"
  highlight). Right-click any row → **Delete** (red), or press **⌘+Backspace** on macOS /
  **Ctrl+Delete** on Linux — that binding is registered as `deleteFile` in
  `packages/constants/schema.json` + the Rust `keybindings::default_config` and surfaces
  through `useShortcuts` to `WorkspaceShell`, which dispatches a `pragma:request-delete-file`
  window event the `FilesTab` listens for. `deleteFile` is skipped when focus is in a
  text-editing context (`isTextEditingContext` in `lib/native-editing.ts` — inputs, the
  terminal, CodeMirror) so the OS-native text-editing behavior takes over instead of
  deleting a file. The controller's `commitDelete` calls
  `deleteFile(worktreeId, path)` immediately and bumps the parent's nonce. The worktree is a
  git checkout, so **delete has no confirmation** — `git checkout -- <path>` / `git clean -fd`
  from a terminal tab is the recovery path. The backend `fs::delete_file` resolves through
  `resolve_in_worktree` (same `..`/symlink guard) and refuses to recurse into non-empty
  directories (`InvalidInput`); use `discard_*` / `clean -fd` from the Changes tab for tracked
  / untracked multi-file removal. **⌘+End** (mac) / **Ctrl+End** (linux) is registered as
  `scrollTerminalBottom` and scrolls the active terminal viewport to the live cursor row
  (`TerminalManager.scrollToBottom` → xterm `scrollToBottom`). **Escape closes any open
  modal**: radix `Dialog`/`AlertDialog` dismiss on Escape natively, and the hand-rolled
  `CreateProjectDialog` / `CreateWorktreeDialog` use the `useEscapeToClose` hook
  (`hooks/use-escape-to-close.ts`) for the same behavior. Git has no edit
  notification, so **Changes polls `worktree_changes` every 2s while mounted** (and on window
  focus), updating the lists in place without re-flashing the loading state (`ChangesTab`).
  `worktree_changes` returns all three axes (`committed` = base→HEAD, `staged` = HEAD→index via
  `git diff --cached`, `unstaged` = index→working tree plus untracked); `DiffSide` has a matching
  variant for each. **Clicking a file in any of the three lists opens one unified diff** on the
  fourth `DiffSide`, `worktree` (base merge-base → working tree): `file_diff`'s `Worktree` arm
  diffs the file's current on-disk content against what it was at the worktree's fork point,
  folding committed + staged + unstaged edits into a single review view (parentless/main worktrees
  fall back to HEAD as the base). The per-axis `committed`/`staged`/`unstaged` sides remain for the
  listing records but are no longer used as the click target. `ChangeGroup` is generic over per-row `fileActions` and per-header
  `headerActions` (icon buttons): the **Unstaged** group gets stage (`stage_file`) + discard, the
  **Staged** group gets unstage (`unstage_file`); the headers get the stage-all/unstage-all/
  discard-all variants. Staging is reversible so it runs **without confirmation** (`stage_file` /
  `stage_all` = `git add`; `unstage_file` / `unstage_all` = `git restore --staged` / `git reset`),
  whereas discard (`discard_unstaged_file` / `discard_all_unstaged` — `git restore` for tracked,
  delete / `git clean -fd` for untracked) is **irreversible** and routes through a confirmation
  `AlertDialog`; every action does an immediate in-place refresh. Once a child worktree has no
  staged/unstaged changes, the commit controls are replaced by lifecycle actions: committed changes
  show `merge_worktree_to_parent` (runs `git merge <child-branch>` in the clean parent worktree and
  leaves conflicts there for IDE / `git merge --continue` or `git merge --abort` resolution), and a
  fully merged/no-change child shows the same `WorktreeDeleteDialog` used by the left sidebar. The
  left sidebar polls `worktrees_merged_status` for child worktrees (one compact boolean map, not full
  file lists) and swaps the branch glyph to a merge glyph while the merged-but-not-deleted worktree
  remains in the tree. Files open as two new
  `TabKind`s — `editor` (CodeMirror 6, save on ⌘/Ctrl-S, **no autosave**) and `diff` (read-only
  `@codemirror/merge`) — rendered through the `SplitHost` switch and located by `Tab.filePath`
  (worktree-relative) + `Tab.diffSide` (v5 migration; the columns persist editor/diff tabs). Open
  them via `openFileTab`/`openDiffTab` on the workspace context (they dedupe by kind+filePath(+side)).
  **Both views are syntax-highlighted.** The grammar is resolved lazily by filename through the
  shared `loadLanguageExtension` helper (`components/editor/codemirror-language.ts`, backed by
  `@codemirror/language-data`) so editor and diff pick the same grammar; the colors come from the
  shared dark `pragmaHighlightStyle` / `pragmaSyntaxHighlighting` in `codemirror-theme.ts` (keyed to
  `@lezer/highlight` tags, tuned for the `#0b0d10` background). `MergeDiff` applies both the grammar
  and the highlight extension to **both** `@codemirror/merge` panes (swapping the grammar through
  compartments once it loads); `EditorView` adds the same extensions alongside its save keymap.
  Editor dirty state + latest doc is an **ephemeral** module store (`state/editor-dirty-store.ts`,
  never in the reducer, never persisted); closing a dirty editor routes through
  `ConfirmCloseProvider` (`components/editor/confirm-close.tsx`). vscode-icons render **offline**
  via `lib/file-icons.ts` (`addCollection` once — never let `@iconify/react` fetch over the
  network). The `lucide:*` / `simple-icons:*` **editor launcher brand icons** are bundled the
  same way, but from a **curated subset** (`lib/brand-icons.json`, registered by
  `lib/brand-icons.ts`, imported once in `main.tsx`) — never add the full multi-MB
  `@iconify-json/{lucide,simple-icons}` packages; when you add a `brandIcon` to
  `values.json`, add that icon's body to `brand-icons.json` too. All filesystem + git work is
  **worktree-scoped and worktree-relative**: every `fs.rs` / `git.rs` command takes a
  `worktreeId` + a relative path, and `resolve_in_worktree` rejects `..`/absolute/symlink
  escapes (`InvalidInput`) — **no absolute path ever crosses IPC**. `editors::open_worktree`
  follows the same rule: it takes a `worktreeId` and resolves the absolute path from the DB,
  never trusting a path from the frontend.
  The file-tree context menu floats over browser panes, so it registers with
  `lib/native-overlay.ts` via `useSuppressNativeOverlayWhile(open)`.
- **Terminal font** is a Nerd Font-first stack (`JetBrainsMonoNL Nerd Font`,
  `JetBrainsMono Nerd Font`, `JetBrains Mono`, `SF Mono`, Menlo, Monaco,
  `ui-monospace`, `monospace`) at **fontSize 14 / lineHeight 1.0**. 14px is the
  size Nerd Font's block / box-drawing glyphs are designed against — at 13px
  macOS WebKit rounds the cell to 15px and the half-block glyphs end up with a
  1px anti-aliased seam running through the middle of every character (visible
  strikethrough across Claude Code / opencode ASCII art). See `TERMINAL_FONT_FAMILY`,
  `TERMINAL_FONT_SIZE`, `TERMINAL_LINE_HEIGHT` in `terminal-manager.ts`.
- **Toasts** use `sonner` (`@/components/ui/sonner.tsx` + a `<Toaster />`
  mounted once in `main.tsx`). Trigger via `toast.success("Copied worktree
path")` from inside the action handler — never from inside the reducer.
  Clipboard reads/writes go through `navigator.clipboard` with a try/catch
  that surfaces the error via `toast.error(...)`.
- **Worktree lifecycle.** `Worktree` rows carry a `hidden` boolean
  (persisted in SQLite via the v3 migration). Hidden rows are filtered out of
  the sidebar via `buildWorktreeTree(worktrees, { predicate: (w) => !w.hidden })`
  and surfaced again through a "Show N hidden" toggle at the bottom of the
  list. When the user hides the currently-selected worktree, the reducer
  falls back to the main worktree (or the first remaining root) so the
  workspace never points at a hidden id.
- **Project scripts.** A project may define trusted lifecycle scripts in
  `<project>/.pragma/scripts.json`; the file is project-owned and never stored
  in SQLite. Pragma only adds `.pragma/worktrees/` to the project's
  `.git/info/exclude` (and migrates its old broad `.pragma/` entry), so
  `.pragma/scripts.json` remains commit-ready. Rust derives the path from
  `Db::project(project_id).path` — IPC never accepts an arbitrary script path. Shape lives in `@pragma/constants`
  (`ProjectScriptsConfig`, `RunScriptEntry` / `RunScriptNode`) and supports
  `setup: string[]`, `teardown: string[]`, and `run: Array<string | split>`
  where split objects use exactly one axis (`left`/`right` = horizontal,
  `top`/`bottom` = vertical) and may nest. `setup` runs headlessly after a new
  worktree row exists; failures leave the worktree on disk/SQLite and return a
  structured error with stdout/stderr. `teardown` runs headlessly before PTYs
  are killed and before git removes the worktree; any failure blocks deletion,
  so the frontend delete dialog must wait for backend success before removing
  the row. Headless commands run from the worktree root through `$SHELL -lc`,
  inherit the user's environment, and receive `PRAGMA_WORKTREE_PATH`,
  `PRAGMA_PROJECT_PATH`, and `PRAGMA_WORKTREE_ID` (no `PRAGMA_TAB_ID` because
  there is no visible terminal). They run concurrently up to
  `constants.scripts.maxConcurrentCommands`. Interactive `run` scripts are
  frontend-owned: `workspace-context` loads the config via `load_project_scripts`,
  creates normal terminal tabs and/or existing split layouts, and injects
  commands through `terminalManager.writeWhenReady(tabId, command + "\r")` so no
  daemon protocol change is required. The header play/stop button in
  `TerminalTabs` tracks the run-managed tab ids; stop closes exactly those tabs.
- **Active selection persists across restarts.** The last active project and
  each project's last active worktree are saved in the `settings` table under
  one opaque, frontend-owned JSON key (`activeSelection`) via the
  `get_active_selection` / `set_active_selection` commands — Rust stores the
  string verbatim, never parsing it (same pattern as split layouts). The
  mount-time `reload` rehydrates (`hydrate-selection` seeds
  `selectedProjectId` + `selectedWorktreeByProject`, then `set-projects`
  validates the project id against the loaded list and falls back to the
  first project if it was deleted elsewhere); a persist effect writes on every
  selection change, gated by `didHydrateRef` so the initial empty state can't
  clobber a saved selection, and deduped by `lastPersistedRef`. The in-memory
  `set-worktrees` reducer already honored a remembered worktree when one
  existed, so this is purely the missing persistence layer — switching away
  from a project and back (in-session or across restarts) now returns to the
  worktree the user left off on.

## Common commands

All commands run from the repo root unless noted. We use **bun** as the package
manager and **turbo** as the task runner.

```bash
bun install                # Install all workspace deps

# App
bun run dev                # Run the desktop app — native window + Vite (Tauri dev, "Pragma Dev" branding via tauri.dev.conf.json)
bun run --filter pragma tauri:build   # Build the desktop app (macOS/Linux bundles, production "Pragma" branding)

# Quality gates (root)
bun run lint               # oxlint across the repo
bun run format             # oxfmt --write (auto-fix formatting)
bun run format:check       # oxfmt --check (CI)
bun run typecheck          # turbo: generate constants -> tsc across packages
bun run test               # turbo: Vitest across packages
bun run rust:fmt           # cargo fmt --all
bun run rust:clippy        # cargo clippy -D warnings
bun run rust:test          # cargo test --workspace
bun run check              # Everything CI checks, in one shot

bun run generate           # Regenerate shared-constant types from schema/values
cargo run -p pragma-daemon # Run the detached PTY daemon directly for debugging
cargo run -p pragma-agent-cli -- --agent dev report started # Manually send an agent report (inside a Pragma terminal env)
```

## Code standards (consistent across TypeScript & Rust)

Formatting is **automated and non-negotiable** — oxfmt for TS, rustfmt for Rust. Don't
argue with the formatter; run it. Both are enforced in CI and auto-applied on commit.
The conventions below are the parts the formatter can't decide for you, and they are
deliberately mirrored across the two languages.

| Concept            | TypeScript                                        | Rust                                                          |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------- |
| Variables / fns    | `camelCase`                                       | `snake_case`                                                  |
| Types / components | `PascalCase`                                      | `PascalCase`                                                  |
| Constants          | `UPPER_SNAKE` (true consts) / `camelCase` objects | `UPPER_SNAKE`                                                 |
| Files              | `kebab-case.ts`, `PascalCase.tsx` (components)    | `snake_case.rs`                                               |
| JSON keys (wire)   | `camelCase` (canonical)                           | `camelCase` on the wire; `snake_case` fields via serde rename |
| Module boundaries  | One responsibility per file/module                | One responsibility per file/module                            |

Shared rules:

- **Strictness is on, everywhere.** TS runs in `strict` mode with
  `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc. Rust runs clippy
  `all` + `pedantic` as `-D warnings` and `unsafe_code = "forbid"`. Treat warnings as
  errors. Don't silence a lint without a comment explaining why.
- **Errors are values, surfaced explicitly.** TS: prefer returning/throwing typed
  errors and narrowing with `instanceof`; never swallow. Rust: return `Result`, use
  `?`; reserve `expect`/`panic!` for genuinely-unrecoverable startup invariants (and
  write the invariant in the message, as `CONSTANTS` does).
- **No magic values.** Cross-boundary values live in `@pragma/constants`. Frontend-only
  shared values live in `src/lib/`.
- **Imports are grouped** (oxfmt/rustfmt enforce ordering): external deps, then
  workspace packages, then local/relative. Keep side-effect imports (CSS, test setup)
  explicit.
- **Public items are documented.** Exported TS functions/types get a JSDoc line; public
  Rust items get a `///` doc comment.
- **Keep the IPC surface typed and centralized.** Every Tauri command has a matching
  typed wrapper in `src/lib/tauri.ts` and a `#[tauri::command]` in `src-tauri/src/lib.rs`
  with the same name. Share the payload types via `@pragma/constants` where possible.

## Shared constants workflow (the single source of truth)

`packages/constants` is consumed by **both** the React frontend and the Rust backend.
To add or change a shared value:

1. Edit `packages/constants/schema.json` (the shape/contract).
2. Edit `packages/constants/values.json` (the value). It must satisfy the schema.
3. Run `bun run generate` (TS types regenerate, including unreferenced schema
   definitions; Rust regenerates on next build).
4. Use it:
   - **TS:** `import { constants } from "@pragma/constants"` → `constants.app.name`
   - **Rust:** `pragma_constants::CONSTANTS.app.name`

The Rust side parses `values.json` against the schema-generated types at startup and
**panics loudly** if they ever drift apart — that's intentional. If you change window
defaults or the app identifier here, mirror them in `src-tauri/tauri.conf.json`
(Tauri reads its config statically; keep the two in sync).

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

## Commits

[Conventional Commits](https://www.conventionalcommits.org), enforced locally and in CI:

```
<type>(<scope>): <subject>
```

- **types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scope:** optional; prefer a package/app name (`pragma`, `constants`, `ci`, `deps`)
- Examples: `feat(pragma): add settings window`, `fix(constants): correct min width`

## Git hooks (Husky)

- **pre-commit:** `lint-staged` auto-fixes staged files (`oxlint --fix`, `oxfmt --write`,
  `rustfmt`). Fixing — not just checking — is the local behavior.
- **commit-msg:** commitlint validates the message.
- **pre-push:** full `typecheck` + `cargo fmt --check` + `cargo check`.

CI re-verifies everything in **check** mode (it never auto-fixes): commitlint, oxlint,
oxfmt `--check`, typecheck, `cargo fmt --check`, clippy, both test suites, and a
compile-only Tauri build on macOS **and** Linux.

## Platform targets

We target **macOS and Linux only** right now. `tauri.conf.json` bundles
`app`/`dmg` (macOS) and `deb`/`rpm`/`appimage` (Linux). Don't add Windows/Android
specifics without updating this guide and CI. Linux builds need the GTK/WebKit system
libraries — see the `rust`/`build` jobs in CI for the exact `apt` list. Note `xcap`
(screen capture for browser snapshots) pulls in `libspa-sys`, which needs
`libpipewire-0.3-dev` on Linux at build time, and its wayland/GL capture path links
against `gbm`, so `libgbm-dev` is required at link time (otherwise `cargo test` / the
Tauri build fail with `unable to find library -lgbm`). `libspa-sys` uses bindgen, so
`libclang-dev` is also installed explicitly; GitHub-hosted runners may already have it, but
`act` images do not. These packages are in the CI apt list (the `rust` **and** `build` jobs)
and must stay there.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
