# crates/pragma-core - Host Business Logic

Pure Rust library for host-side Pragma business logic. It must not depend on
Tauri or client presentation code.

## Responsibilities

- Git, filesystem, project/worktree/tab/settings, kanban, DB, watcher, and host
  RPC logic as it is extracted from `apps/pragma/src-tauri`.
- Shared validation and error mapping used by `pragma-server`.
- Server-side state semantics: authoritative SQLite data, optimistic/versioned
  writes, and path validation against known host worktrees.

## Rules

- No Tauri dependencies.
- Protocol method/event names come from `packages/constants`.
- Keep this crate synchronous unless an async boundary is unavoidable; the
  server remains thread-per-connection.
- New host business logic should move here before being exposed over
  `pragma-server` RPC.
