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

- **Done (host RPC):** `filesystem` (`fs.rs`), `git` (`git.rs`), headless
  lifecycle command execution (`exec.rs`), and managed scratchpad listing
  (`scratchpads.rs`), plus durable whiteboard CRUD/search/rendering (`whiteboards.rs`), the host account store and
  binding rules (`accounts.rs`: `~/.pragma/accounts.json`, owner-only credential dirs under
  `~/.pragma/accounts/<provider>/<login>`, project override > global > default login),
  are implemented behind `Core::handle_rpc`. The Tauri commands in `apps/pragma` resolve trusted
  absolute project/worktree roots (and, for git, DB-derived parent branches)
  from the client DB, then forward via `PragmaClient::rpc`. The host
  re-validates paths and runs the work on its own disk, so the same command
  serves a local project and an SSH-bridged remote one. Worktree lifecycle
  operations (exclude setup, create/remove, branch delete, dirty check,
  headless-checkout listing) and setup/teardown scripts run on the owning host.
  Forced removal retries transient `DirectoryNotEmpty` races from dying worktree
  processes, but still surfaces persistent filesystem and permission failures.
- **Migrating metadata:** legacy project/worktree/tab rows remain in the client
  DB, but daemon-owned terminal agent metadata now uses the `tabs` RPC so it
  persists with the host that owns the PTY. `tabs.rs` also owns the
  agent-session lifecycle contract the desktop and the CLI speak:
  `PrepareAgentLaunch` (`{command, runId?, commandLine?}`; the original argv
  comes back unchanged for an agent that did not opt into resume, and
  `commandLine` is the argv quoted for the shell the tab actually runs),
  `RestoreAgentSession`
  (`{restored}`; an eligible record that cannot resume is an RPC error, never a
  silent fallback), and the CLI-internal `StartRun`/`FinishRun` run-lifecycle
  ops. The durable record and its rules live on the host in
  `crates/pragma-server` (`invocations.rs`, `agent_resume.rs`). Other metadata
  domains still return
  `UnsupportedMethod` from core — by design (see `pragma-client/router.rs`).
- `tabs::SessionRestoreSnapshot` is the read-only `sessionRestoreStatus` response:
  boot-scoped attempted-restore progress and startup-pass completion, not recovery identity.
- GitHub API/auth and AI are intentionally kept as local sidecars, not core RPC.
  Worktree-scoped git operations that support the GitHub PR flow still belong in the
  `git` RPC, because they must execute on the host that owns the worktree path.
- `exec` batches are cancellable: an `ExecRequest` carrying a `runId` is
  registered for its lifetime, and a second `exec` call with `{ "cancelRunId" }`
  (on its own pooled connection, so it is served concurrently) kills the batch's
  live process trees and skips its queued commands; those results come back with
  `cancelled: true`. Agent prompts' `!!` pre-launch commands use this for
  their **Skip** action.
- `prelaunch.rs` holds the pure `!!` rules (split the inline `` !!`command` ``
  chips out of a prompt, format each command's output for the agent). Its TypeScript twin is
  `apps/pragma/src/lib/prelaunch-commands.ts` — the desktop runs single launches,
  the host runs fanout attempts — and the two must stay byte-identical; both
  test suites pin the same cases. The prefix and output limit are shared
  constants (`agents.prelaunchCommandPrefix`, `agents.prelaunchOutputLimit`).
- Request payload enums (`fs::FsRequest`, `git::GitRequest`,
  `scratchpads::ScratchpadsRequest`, `whiteboards::WhiteboardsRequest`) are the client↔core contract; both sides
  depend on this crate to build/parse them.
- `scratchpads::ExportHtml` saves uniquely named standalone HTML exports under
  `constants.scratchpads.exportsDirectory`, ensures Git excludes are present, and
  uses the filesystem's path validation. Bundling stays in the client.
- `scratchpads::list` is the **only** place scratchpad frontmatter is parsed on
  the host: the desktop's `list_scratchpads` command and the gateway's
  `GET /v1/scratchpads` both go through it, so the sidebar and a paired phone
  can never disagree about what a scratchpad is or which agent it is attached to.
- `FsRequest::PaletteSearch` performs bounded filename and smart-case literal code
  search across client-resolved worktree roots. Git roots enumerate candidates through
  `git ls-files --cached --others --exclude-standard`, making `.gitignore`, linked-worktree
  metadata, `.git/info/exclude`, and global excludes authoritative; non-Git roots fall back
  to the ignore walker. It enforces root/query/file/result/byte limits, deadlines,
  two-search concurrency, and cancellation; responses contain only worktree-relative paths.
- All `git` subprocess calls go through `process_env::command` so a GUI-launched
  host still finds `git` on `PATH`.
- `process_env::command` **resolves** the program against that augmented `PATH` before
  spawning, and on Windows adds `%APPDATA%\npm`, the WindowsApps aliases, and Scoop shims
  to it — a GUI host does not inherit the `PATH` an interactive shell builds. Resolution
  is what lets a `.cmd` shim (`npm`) reach `pragma_platform::process::command`, which lets Rust launch it through `cmd.exe`; `resolve_program` also maps `sh` to Git for Windows' `bash.exe`
  because the official plugin installers are POSIX scripts and Windows has no `sh`.
- `GitRequest::CreateWorktree.sourceBranch` materializes an existing `origin` branch
  as a tracking worktree (used by stacked PR layers); without it, creation retains the
  original new-branch-from-parent behavior.
- `git::merged_status` preserves a per-item result (errors become `false`) but runs
  at most four worktree checks concurrently. Each clean check can launch three git
  subprocesses, so never restore the old one-thread-per-worktree fan-out.
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

- **Storage scans (`storage.rs`) skip `.pragma/worktrees/`** so a main checkout never
  counts its linked worktrees twice, charge allocated bytes once per hard-linked inode
  (`pragma_platform::disk`), and take ignored folders from
  `git ls-files --others --ignored --exclude-standard --directory`. `DeleteIgnoredFolder`
  never trusts the client's list: it re-runs `git check-ignore`, refuses links and
  anything under `constants.storage.protectedFolders` (`.git`, `.pragma`), then removes.
  Palette search and storage scans share `cancel::CancelRegistry` for cancel-by-id.

- **Whiteboard renders go through the one shared engine (`whiteboard_render.rs`).** Never
  build an `excalidraw_image::Engine` per request: each one recompiles the bundled Excalidraw
  core and is its own V8 isolate, and parallel requests on the server's per-connection threads
  exhausted V8's code-range reservation and aborted `pragma-server`
  (`Failed to reserve virtual memory for CodeRange`). `render_svg` queues to a single worker
  thread that reuses its engine and rebuilds it only after a failed render. Do not use
  `Engine::new_cached` either — on a cache miss it re-executes the current binary, which here is
  `pragma-server`, to bake a snapshot.
- **A field added to an RPC response must be optional on the wire.** The client talks to
  whatever server is already running — a detached dev server from an earlier build, or
  an SSH host on an older release — and `daemon.protocolVersion` only moves on a release,
  so a newly required field fails the whole call with `json error: missing field`. That
  is exactly how `WorktreeStorage.tree` first shipped; it is now optional and the client
  degrades (one box per worktree) instead of failing.

## Rules

- No Tauri dependencies.
- Protocol method/event names come from `packages/constants`.
- Keep this crate synchronous unless an async boundary is unavoidable; the
  server remains thread-per-connection.
- New host business logic should move here before being exposed over
  `pragma-server` RPC.
- Worktree filesystem watches deliberately use `notify-debouncer-full`'s
  `NoCache` on every platform. Its `RecommendedCache` eagerly walks and retains
  every path on macOS and Windows (including dependency trees and nested
  worktrees), while file previews only need invalidations. Keep the recursive
  OS watch and all non-`.git` events intact; do not trade resource use for
  suppressing `node_modules`, build output, or other user-visible files.

Computer-use rules are split between `computer.rs` (policy, geometry, input and revalidation) and `computer_task.rs` (literal variables, observed URLs, screen fingerprints and decision validation). Confidence and item-margin thresholds are enforced here even after the TypeScript decision builder validates offered choices.

`request_text` only returns a question to the caller, so it is exempt from native-action
confidence thresholds. Uncertain native actions still fail validation.
