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
  operations (exclude setup, create/remove, branch delete, dirty check,
  headless-checkout listing) and setup/teardown scripts run on the owning host.
- **Migrating metadata:** legacy project/worktree/tab rows remain in the client
  DB, but daemon-owned terminal agent metadata now uses the `tabs` RPC so it
  persists with the host that owns the PTY. Other metadata domains still return
  `UnsupportedMethod` from core — by design (see `pragma-client/router.rs`).
- GitHub API/auth and AI are intentionally kept as local sidecars, not core RPC.
  Worktree-scoped git operations that support the GitHub PR flow still belong in the
  `git` RPC, because they must execute on the host that owns the worktree path.
- Request payload enums (`fs::FsRequest`, `git::GitRequest`) are the client↔core
  contract; both sides depend on this crate to build/parse them.
- `FsRequest::PaletteSearch` performs bounded filename and smart-case literal code
  search across client-resolved worktree roots. Git roots enumerate candidates through
  `git ls-files --cached --others --exclude-standard`, making `.gitignore`, linked-worktree
  metadata, `.git/info/exclude`, and global excludes authoritative; non-Git roots fall back
  to the ignore walker. It enforces root/query/file/result/byte limits, deadlines,
  two-search concurrency, and cancellation; responses contain only worktree-relative paths.
- All `git` subprocess calls go through `process_env::command` so a GUI-launched
  host still finds `git` on `PATH`.
- Headless lifecycle commands resolve their shell and command arguments through
  `pragma_platform::shell`; never assume `/bin/sh -c` exists on the host.
- **Asset files use their own ops.** `FsRequest::ListDir` hides gitignored entries and
  `ReadFile` refuses binary content, which is wrong for asset directories users expect
  to see (e.g. a gitignored `.pragma/assets/sounds`). `ListFileNames` lists files
  unfiltered (optionally by extension) and `ReadBytes` / `WriteBytes` move bytes as
  base64 under the same `MAX_READ_BYTES` cap.
- **`FsRequest::HomeDir` anchors user-scoped paths on the owning host.** It returns
  the host's home directory (via the `pragma-platform` path seam) so a client that
  reaches the daemon through an SSH bridge can root `~/.pragma/*` reads on the remote
  machine instead of guessing the path locally.
- **A binary too big for one frame is read with `ReadBytesRange`.** It returns a
  `FileChunk` (`base64` + `offset` + total `byteSize` + `eof`) capped at
  `constants.files.chunkBytes`, so the caller walks `offset` until `eof` instead of
  hitting `MAX_READ_BYTES` — the PDF viewer's path. Keep the chunk cap comfortably below
  the protocol's 16 MB frame limit: base64 inflates every chunk by 4/3.

## Rules

- No Tauri dependencies.
- Protocol method/event names come from `packages/constants`.
- Keep this crate synchronous unless an async boundary is unavoidable; the
  server remains thread-per-connection.
- New host business logic should move here before being exposed over
  `pragma-server` RPC.
