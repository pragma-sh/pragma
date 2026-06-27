# Terminal Workspace Implementation Prompt

Implement the Pragma terminal workspace described below. Work incrementally, keep changes minimal where possible, and verify each slice before moving on.

## Goal

Turn the existing Pragma scaffold into a terminal workspace for juggling shells across multiple projects and nested git worktrees.

The app has three primary areas:

1. A project/worktree sidebar with project switching.
2. A top terminal tab strip.
3. An xterm.js terminal host.

Business logic belongs in Rust. The frontend is React + shadcn/ui + motion/react. PTYs must live in a detached daemon process so shells survive app window close and can be reattached on relaunch with replayed scrollback.

## Non-Negotiable Architecture

1. Do not run PTYs in the Tauri app process.
2. Add a standalone `pragma-server` binary crate that owns all PTY sessions.
3. The Tauri app talks to the daemon over a Unix domain socket using length-prefixed JSON frames.
4. The daemon must be launched detached, not as a Tauri sidecar.
5. On app exit, close the socket only. Do not kill daemon sessions.
6. Persist open terminal tabs in SQLite so relaunch can reattach to live daemon sessions.
7. Terminal output must never flow through React state.
8. All `invoke()` usage remains centralized in `apps/pragma/src/lib/tauri.ts`.
9. Cross-language data contracts belong in `packages/constants`.
10. Keep terminal output outside React state. For workspace state, use React context + reducer or a lightweight state library if it makes tab/project/session coordination cleaner.

## Dependencies

Add npm dependencies:

- `@xterm/xterm`
- `@xterm/addon-fit`
- `@xterm/addon-web-links`
- `motion`
- `@tauri-apps/plugin-dialog`

Add Rust crates:

- `portable-pty`
- `rusqlite` with bundled SQLite
- `uuid`
- `thiserror`
- `base64`
- `tauri-plugin-dialog`

Add shadcn primitives as needed:

- `sidebar`
- `tabs`
- `dialog`
- `tooltip`
- `collapsible`
- `input`
- `label`
- `scroll-area`
- `separator`
- `radio-group`
- `popover`

Add `"dialog:default"` to `capabilities/default.json`.

## Shared Types

Extend `packages/constants/schema.json` with unreferenced definitions for:

- `Project`
- `Worktree`
- `Tab`
- `ProjectIcon`
- Daemon socket protocol request/response frame types

Do not change `values.json` unless an actual constant value is needed.

Keep definitions constraint-light to avoid typify issues. Avoid `minimum`, `format`, and overly clever schema constraints.

Run:

```bash
bun run generate
```

Re-export generated types from the TypeScript and Rust constants packages.

`PtyEvent` is the one allowed hand-written streaming type. It should be a tagged enum with:

- `Output { data }`
- `Exit { code }`

## SQLite Data Model

Use `app_data_dir/pragma.db`.

Create tables:

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  order_index INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE worktrees (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
  branch     TEXT NOT NULL,
  title      TEXT,
  path       TEXT NOT NULL UNIQUE,
  is_main    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_worktrees_project ON worktrees(project_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tabs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id  TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  title        TEXT,
  order_index  INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tabs_project ON tabs(project_id);
```

Model the main project checkout as a `worktrees` row with `is_main = 1` and `parent_id = NULL`.

A tab row's `id` is also the daemon `sessionId`.

## Tauri Command Surface

Implement typed Rust commands and matching camelCase wrappers in `apps/pragma/src/lib/tauri.ts`.

Commands:

- `pty_spawn(sessionId, cwd, cols, rows, onEvent)`
- `pty_attach(sessionId, cols, rows, onEvent)`
- `pty_write(sessionId, data)`
- `pty_resize(sessionId, cols, rows)`
- `pty_kill(sessionId)`
- `list_projects()`
- `add_project(path)`
- `clone_project(remoteUrl, intoDirectory)`
- `get_projects_directory()`
- `list_worktrees(projectId)`
- `create_worktree(projectId, parentWorktreeId, branch, title?)`
- `project_icon(projectId)`

Use Tauri `Channel<PtyEvent>` for terminal output. Do not use global Tauri events.

## Rust App Module Layout

Add or refactor `apps/pragma/src-tauri/src/` into:

- `lib.rs`: app wiring only, managed state, plugin registration, command registration, exit behavior.
- `error.rs`: `AppError` using `thiserror`, serialized as a message string.
- `pty.rs`: daemon client, auto-spawn detached daemon, connect/retry logic, socket framing, command proxying.
- `db.rs`: `Db(Mutex<Connection>)`, migrations via `PRAGMA user_version`, typed CRUD for projects, worktrees, settings, and tabs.
- `git.rs`: git CLI helpers, repo checks, clone, current branch, worktree creation, `.pragma/` exclude handling.
- `projects.rs`: project commands.
- `worktrees.rs`: worktree commands.
- `icons.rs`: project favicon detection and base64 encoding.

Use the git CLI instead of `git2`.

Serialize mutating git operations per project with a mutex.

## Daemon Crate

Create `crates/pragma-server`.

Responsibilities:

- Bind a Unix socket.
- Enforce single instance with a lockfile.
- Detect and remove stale socket files after crashes.
- Own all PTYs and shell children.
- Maintain a session registry.
- Store bounded scrollback per session.
- Replay scrollback on attach before sending live frames.
- Exit only when there are no sessions and no attached clients.

Daemon modules:

- `main.rs`: socket bind, lockfile, accept loop, idle shutdown.
- `protocol.rs`: generated/shared protocol types plus framing helpers.
- `session.rs`: PTY spawn, reader thread, UTF-8 carry-over, scrollback ring, subscribers.
- `registry.rs`: spawn, attach, write, resize, kill.

Socket path:

- Linux: `$XDG_RUNTIME_DIR/pragma/daemon.sock`
- Fallback and macOS: `app_data_dir/daemon.sock`

PTY behavior:

- Shell is `$SHELL -l`
- Fallback shell is `/bin/zsh` on macOS and `/bin/sh` on Linux
- Set `TERM=xterm-256color`
- Set `COLORTERM=truecolor`

## Frontend Layout

Implement the workspace UI without putting business logic in components.

State management guidance:

- Prefer the simplest approach that keeps project, worktree, tab, and session state easy to reason about.
- React context + reducer is acceptable if the state remains straightforward.
- A lightweight state library such as Zustand is acceptable if it reduces prop drilling, simplifies cross-component updates, or makes persisted tab/session coordination clearer.
- Do not route terminal output through the state layer, regardless of the state approach.
- Keep the state API narrow and typed; components should dispatch high-level workspace actions rather than embed persistence or Tauri command details.

Required files under `apps/pragma/src/`:

- `lib/tauri.ts`: command wrappers, `Channel` construction, `PtyEvent` union.
- `lib/platform.ts`: platform modifier helpers and shortcut labels.
- `lib/terminal-manager.ts`: non-React xterm session registry, spawn/attach, resize, write handling.
- `lib/worktree-tree.ts`: pure `Worktree[]` to tree builder.
- `state/workspace-context.tsx` or `state/workspace-store.ts`: workspace state provider/store for projects, worktrees, selection, tabs, active tab, and icon cache.
- `hooks/use-shortcuts.ts`: window-level project and tab shortcuts.
- `components/workspace/WorkspaceShell.tsx`: main layout.
- `components/sidebar/ProjectSidebar.tsx`: sidebar composition.
- `components/sidebar/WorktreeTree.tsx`: recursive worktree tree.
- `components/sidebar/ProjectSwitcher.tsx`: project icons, switching, swipe.
- `components/tabs/TerminalTabs.tsx`: tab strip.
- `components/terminal/TerminalHost.tsx`: renders all open terminals and hides inactive ones.
- `components/terminal/TerminalView.tsx`: xterm container and one-shot session creation.
- `components/dialogs/CreateProjectDialog.tsx`: open existing project or clone remote.
- `components/dialogs/CreateWorktreeDialog.tsx`: create nested worktree from selected parent.

Important frontend rules:

- Import `@xterm/xterm/css/xterm.css`.
- Hidden terminal tabs must not unmount.
- Fit xterm on activation because hidden containers cannot be measured.
- Debounce resize around 75ms.
- Use `attachCustomKeyEventHandler` so project/tab shortcuts bubble when xterm is focused.
- New terminal tabs use the currently selected worktree path as cwd.
- Project directory selection must use the native dialog plugin, never a typed path input.

## UX Requirements

Sidebar:

- The project name row represents the main checkout.
- Worktrees nest by SQLite `parent_id`.
- Worktree rows expose collapse and create-child affordances.
- Project switcher is ordered by `order_index`.
- Project icon is a detected favicon from Rust, with numeric fallback.
- Horizontal wheel/swipe on the sidebar switches projects with threshold and cooldown.

Tabs:

- Top tab strip supports create, close, and switch.
- Inactive terminals are hidden with CSS only.
- Tab state is persisted in SQLite.
- Relaunch reattaches persisted tabs to daemon sessions.

Shortcuts:

- macOS uses `Ctrl`.
- Linux uses `Alt`.
- Modifier + `1` to `9` jumps to project by order.
- Modifier + `Tab` cycles tabs forward.
- Modifier + `Shift+Tab` cycles tabs backward.

Dialogs:

- Create project supports opening an existing directory or cloning a remote.
- Native directory picker default path comes from persisted `projectsDirectory`.
- Opening a project persists the selected directory's parent.
- Cloning persists the clone destination directory.
- Create worktree requires branch name and accepts optional display title.
- New nested worktrees branch from the parent worktree's current `HEAD`.

## Git Behavior

Worktree checkouts live at:

```text
<project>/.pragma/worktrees/<id>
```

Append `.pragma/` idempotently to `.git/info/exclude`.

Create worktrees with the parent checkout as the base:

```bash
git -C <parent_path> worktree add -b <branch> <path>
```

Surface git stderr verbatim in dialogs.

## Favicon Detection

Search these directories in order:

- project root
- `public`
- `static`
- `assets`
- `src`
- `src/assets`
- `app`

Search these names in order:

- `favicon.svg`
- `favicon.ico`
- `favicon.png`
- `icon.svg`
- `icon.png`

Return `{ mime, dataBase64 }`.

Cache icons in the frontend for the current app run.

## Implementation Sequence

1. Add dependencies, shadcn primitives, daemon crate workspace member, dialog plugin, and capability.
2. Run the full quality gate and keep the scaffold green.
3. Add shared schema definitions and generate types.
4. Implement daemon core first: socket, lockfile, protocol framing, registry, PTY sessions, UTF-8 carry-over, scrollback replay, attach/write/resize/kill.
5. Add daemon integration tests before UI work.
6. Implement app-side daemon client and PTY Tauri commands.
7. Build a minimal terminal view with cwd `$HOME` and verify prompt, typing, resize, exit.
8. Close and reopen the app, then verify shell survival and scrollback replay.
9. Add SQLite migrations and CRUD for tabs.
10. Add reducer state, tab strip, terminal host, tab create/close/switch, persisted tab reattach.
11. Add keyboard shortcuts and xterm key passthrough.
12. Add project persistence, git helpers, project commands, native project dialog, project switcher, icons, and swipe switching.
13. Add worktree persistence, worktree commands, tree builder, nested worktree UI, and create-worktree dialog.
14. Polish empty states, inline errors, motion transitions, and resize behavior.
15. Update `AGENTS.md` and relevant skills if repo structure or workflows changed.
16. Run all checks.

## Testing Requirements

Rust:

- `db.rs` migrations and CRUD using `Connection::open_in_memory()`.
- `git.rs` integration tests using temp repos.
- UTF-8 carry-over unit tests.
- Scrollback ring unit tests.
- `icons.rs` tests using temp directories with planted icons.

Daemon:

- Spawn `/bin/sh -c "printf hi"` and assert output and exit.
- Spawn long-lived shell, write input, drop client, reconnect, attach, and assert replay before live output.
- Kill session and assert reader unblocks and session is removed.
- Start second daemon and assert single-instance behavior.

TypeScript:

- Mock `@tauri-apps/api/core`.
- Mock `Channel`.
- Mock `@xterm/xterm`.
- Test `worktree-tree.ts`.
- Test reducer behavior.
- Test `platform.ts`.
- Test tab create, close, and cycle behavior.
- Test project and worktree dialogs.
- Assert project dialog uses native picker and does not expose a typed path input.

## Gotchas

1. Preserve UTF-8 boundaries in daemon PTY reads. Do not use `from_utf8_lossy` as the primary strategy.
2. Do not kill daemon sessions on app exit.
3. Reader thread shutdown must drop PTY handles before joining.
4. Handle stale socket files after daemon crashes.
5. Send resize after attach so shell geometry matches the current xterm.
6. Do not fit xterm while hidden with `display: none`.
7. Do not route terminal output through React.
8. Do not use the xterm WebGL addon because WebKitGTK reliability is poor.
9. `rusqlite::Connection` is `!Sync`, so wrap it in `Mutex`.
10. Budget for clippy pedantic cast warnings and justify any lint allow.

## Verification

Run:

```bash
bun run generate
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run rust:fmt
bun run rust:clippy
bun run rust:test
```

If feasible, also run:

```bash
bun run check
```

Manual verification must include:

1. Open app and spawn a terminal.
2. Type into shell and resize window.
3. Close the app window.
4. Reopen app.
5. Confirm terminal session is still alive.
6. Confirm scrollback replay appears before live output.
7. Create a project through native picker.
8. Create a nested worktree.
9. Open a new tab in the selected worktree.
10. Confirm keyboard shortcuts work while xterm is focused.

Also use the `tauri-agent-code` skill to test the actual running Tauri app end-to-end. Launch the app, interact with it like a user, and click through every implemented flow:

1. Open the app and verify the workspace renders.
2. Create/open a project through the native picker flow.
3. Switch projects through the sidebar project switcher.
4. Use sidebar swipe/scroll project switching.
5. Create a nested worktree from a selected parent.
6. Select main and nested worktrees and confirm terminal cwd changes correctly for new tabs.
7. Create, switch, and close terminal tabs.
8. Type into terminals and verify output renders normally.
9. Resize the window and confirm terminal fit behavior.
10. Verify keyboard shortcuts while xterm is focused.
11. Close the app, reopen it, and confirm persisted tabs reattach to live daemon sessions.
12. Confirm scrollback replay appears before live output.
13. Exercise dialog error paths where feasible.
14. Check for visible layout issues, broken hover states, focus problems, and console/runtime errors.

Do not consider the implementation complete until the actual app has been tested through `tauri-agent-code`, not only unit tests or static checks.
