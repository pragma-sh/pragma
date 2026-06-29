# crates/pragma-core - Host Business Logic

Pure Rust library for host-side Pragma business logic. It must not depend on
Tauri or client presentation code.

## Responsibilities

- Git, filesystem, project/worktree/tab/settings, kanban, DB, watcher, and host
  RPC logic as it is extracted from `apps/pragma/src-tauri`.
- Shared validation and error mapping used by `pragma-server`.
- Server-side state semantics: authoritative SQLite data, optimistic/versioned
  writes, and path validation against known host worktrees.

## Status of the migration

- **Done (host RPC):** `filesystem` (`fs.rs`), `git` (`git.rs`), and headless
  lifecycle command execution (`exec.rs`) are implemented behind
  `Core::handle_rpc`. The Tauri commands in `apps/pragma` resolve trusted
  absolute project/worktree roots (and, for git, DB-derived parent branches)
  from the client DB, then forward via `PragmaClient::rpc`. The host
  re-validates paths and runs the work on its own disk, so the same command
  serves a local project and an SSH-bridged remote one. Worktree lifecycle
  operations (exclude setup, create/remove, branch delete, dirty check) and
  setup/teardown scripts run on the owning host.
- **Still client-local:** `database`, `projects`, `worktrees`, `tabs`, `kanban`,
  `settings` remain metadata in the client DB (`pragma.db`) and return
  `UnsupportedMethod` from core — by design (see `pragma-client/router.rs`).
- `github`/`ai` are intentionally kept as local sidecars, not core RPC.
- Request payload enums (`fs::FsRequest`, `git::GitRequest`) are the client↔core
  contract; both sides depend on this crate to build/parse them.
- All `git` subprocess calls go through `process_env::command` so a GUI-launched
  host still finds `git` on `PATH`.

## Rules

- No Tauri dependencies.
- Protocol method/event names come from `packages/constants`.
- Keep this crate synchronous unless an async boundary is unavoidable; the
  server remains thread-per-connection.
- New host business logic should move here before being exposed over
  `pragma-server` RPC.
