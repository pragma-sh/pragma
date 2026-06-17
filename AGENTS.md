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

| Concern          | Choice                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| Monorepo / tasks | [Turborepo](https://turbo.build) + [Bun](https://bun.sh) workspaces             |
| Desktop shell    | [Tauri v2](https://v2.tauri.app) (targets: **macOS + Linux only**)              |
| Frontend         | [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript           |
| Styling / UI     | [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) |
| Backend          | Rust (Tauri commands)                                                           |
| Shared constants | JSON Schema → typed TS (`json-schema-to-typescript`) + Rust (`typify`)          |
| Lint (TS)        | [oxlint](https://oxc.rs)                                                        |
| Format (TS)      | [oxfmt](https://oxc.rs)                                                         |
| Lint (Rust)      | clippy (`-D warnings`, `all` + `pedantic`)                                      |
| Format (Rust)    | rustfmt                                                                         |
| Tests            | Vitest (TS) + `cargo test` (Rust)                                               |
| Commits          | Conventional Commits (commitlint)                                               |
| Git hooks        | Husky + lint-staged                                                             |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                                     |

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
│       │   │   └── utils.ts     # cn() + small utilities
│       │   ├── state/           # Workspace context/reducer for projects/worktrees/tabs only
│       │   ├── test/setup.ts    # Vitest setup
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── src-tauri/           # Rust backend
│           ├── src/lib.rs       # App wiring, managed state, plugins, command registration
│           ├── src/db.rs        # SQLite migrations + typed CRUD
│           ├── src/pty.rs       # Detached daemon client + PTY command proxying
│           ├── src/git.rs       # Git CLI helpers (worktree_changes / worktrees_merged_status / file_diff / stage_* / discard_*)
│           ├── src/fs.rs        # Worktree-scoped, path-safe filesystem commands
│           ├── src/main.rs      # Thin entrypoint
│           ├── tauri.conf.json  # Window/bundle config (mirror values from @pragma/constants); bundles pragma-daemon via externalBin
│           ├── tauri.dev.conf.json # Dev overrides ("Pragma Dev" name/title + icons-dev/) merged via `tauri dev --config`
│           ├── scripts/         # Build helpers (stage-daemon-sidecar.sh — builds + stages the daemon sidecar)
│           ├── binaries/        # Staged `pragma-daemon-<triple>` Tauri sidecar (git-ignored; built, never committed)
│           ├── icons/           # Production app icons
│           └── icons-dev/       # Dev "Pragma Dev" app icons (generated via `tauri icon`)
├── crates/
│   └── pragma-daemon/           # Detached Unix-socket PTY daemon; owns shell sessions + scrollback
├── packages/
│   └── constants/               # Dual TS + Rust package — shared source of truth
│       ├── schema.json          # JSON Schema (the contract). EDIT THIS to change shape.
│       ├── values.json          # The actual values. EDIT THIS to change values.
│       ├── src/index.ts         # Typed TS export
│       ├── src/lib.rs           # Rust export (typify-generated types + parsed values)
│       └── src/generated/       # Generated TS types (git-ignored; never edit)
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
- A reusable UI primitive → `apps/pragma/src/components/ui/` (prefer `shadcn add`).
- Anything that calls the Rust backend → `apps/pragma/src/lib/tauri.ts` (never call
  `invoke()` directly from components).
- PTY/session business logic → `crates/pragma-daemon`; the Tauri app only proxies over
  the Unix socket and must not own PTYs.
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
  plugin, so no `shell:` capability is needed. `binaries/` is git-ignored.
- **Dev and prod must never share a daemon.** The socket/lock/log live in a
  **channel-scoped** directory whose name (`pragma` / `pragma-dev`) is chosen from the
  build's **product identity, not the compile profile**: `daemon_channel_for_product`
  in `src-tauri/src/pty.rs` maps a `product_name` containing `Dev` ("Pragma Dev", set
  in `tauri.dev.conf.json`) to `pragma-dev` and everything else ("Pragma") to `pragma`.
  This is deliberate — a **release-built dev app** (e.g. when profiling terminal latency)
  is still a dev app and must keep its own daemon, which a `cfg!(debug_assertions)` split
  would get wrong (both release builds would collapse onto `pragma`). The app derives the
  channel once at startup from `app.config().product_name` (`lib.rs` → `PtyClient::new`)
  and hands it to the spawned daemon via the **`PRAGMA_DAEMON_CHANNEL` env** alongside
  `PRAGMA_APP_DATA_DIR`; `crates/pragma-daemon/src/main.rs` (`daemon_channel` → `daemon_paths`)
  reads that env, falling back to a `cfg!(debug_assertions)` default only when the daemon is
  run by hand. So both processes resolve the identical path and the two channels never
  collide. (On Linux the dir is `$XDG_RUNTIME_DIR/<channel>`; elsewhere `<app_data_dir>/<channel>`.)
  NB this isolates the **daemon** only — both builds still share `com.pragma.app`'s app-data
  dir and `pragma.db`; give the dev build its own `identifier` if you ever need to split those too.
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
  renderer instead of freezing. **Keystroke input is fire-and-forget and
  pipelined**: `onData` fires `ptyWrite` without awaiting (JS side), and on the
  Rust side `pty_write` runs inline (no `spawn_blocking`) and only *enqueues* onto
  a dedicated writer thread (`input_tx` / `start_input_writer` in
  `src-tauri/src/pty.rs`) that owns its own daemon connection. Writes do **not**
  wait for the daemon's per-write `Response` (a companion `discard_frames` thread
  drains them so the socket buffer can't fill), so consecutive keystrokes pipeline
  instead of each one stalling behind the previous keystroke's full daemon
  round-trip. `resize`/`kill` keep the separate pooled, handshake-free
  request/response connection (`request_conn`). The remaining echo latency is
  structural — every character still crosses two webview↔native IPC boundaries
  plus a socket hop to the detached daemon, where an in-process terminal would
  echo via direct calls.
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
  window event the `FilesTab` listens for. The controller's `commitDelete` calls
  `deleteFile(worktreeId, path)` immediately and bumps the parent's nonce. The worktree is a
  git checkout, so **delete has no confirmation** — `git checkout -- <path>` / `git clean -fd`
  from a terminal tab is the recovery path. The backend `fs::delete_file` resolves through
  `resolve_in_worktree` (same `..`/symlink guard) and refuses to recurse into non-empty
  directories (`InvalidInput`); use `discard_*` / `clean -fd` from the Changes tab for tracked
  / untracked multi-file removal. Git has no edit
  notification, so **Changes polls `worktree_changes` every 2s while mounted** (and on window
  focus), updating the lists in place without re-flashing the loading state (`ChangesTab`).
  `worktree_changes` returns all three axes (`committed` = base→HEAD, `staged` = HEAD→index via
  `git diff --cached`, `unstaged` = index→working tree plus untracked); `DiffSide` has a matching
  `staged` variant. `ChangeGroup` is generic over per-row `fileActions` and per-header
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
Tauri build fail with `unable to find library -lgbm`). Both are in the CI apt list (the
`rust` **and** `build` jobs) and must stay there.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
