# crates/pragma-server - Persistent Host Server

`pragma-server` owns host-side runtime state and listens on an owner-only Unix socket
only. It replaces the old `pragma-daemon` name while preserving the existing PTY,
scrollback, raw output, and agent-status strengths.

## Responsibilities

- Spawning and managing PTY sessions.
- Discovering TCP listeners owned by live PTY shell process trees.
- Coalescing and broadcasting PTY output.
- Tracking runtime agent status in memory.
- Serving `pragma-core` RPC and snapshot-then-delta event subscriptions over the
  existing length-prefixed frame codec.
- Spawning host-side sidecars (`pragma-ai`, `pragma-github`, `pragma-automations`,
  `pragma-plugins`). Automation discovery still scans on its existing cadence, but
  persists and broadcasts runtime state only when the full state changes.
- Supervising persisted remote-access tunnels so mobile connectivity survives desktop
  client exits and restarts.

## Remote access tunnel

`tunnel.rs` owns ngrok/cloudflared process lifetime. Desktop controls it through
`ProtocolRpcMethod::Tunnel`; enable/disable writes `tunnel.enabled` in
`~/.pragma/config.json` while preserving command overrides and unrelated config. On server
startup, enabled tunnels restart against gateway discovery beside `daemon.sock`. Tunnel
process therefore follows persistent server lifetime, not Tauri client lifetime.

## Plugin catalog host

`plugins_host.rs` supervises the `pragma-plugins` sidecar (`@pragma/plugins-host`),
mirroring the `automations` supervisor: a lazily respawned child with a stdout reader
thread. It caches the last `catalog` event plus the hash → asset map; a sidecar crash
never blanks the catalog — a respawn re-runs `load` and the cache holds until a fresh
publish arrives. Public RPC domain `ProtocolRpcMethod::Plugins` actions: `catalog` (returns the
cached catalog), `registerRoots` (project roots, sharing the same desktop RPC that
registers automation roots), `readAsset` (base64 + mime, validated lowercase-hex sha256),
`usageLimits` (correlated sidecar load, optionally filtered by plugin id), and `reload`
(re-sends `load` with freshly read gateway credentials; the gateway calls it
right after writing its discovery file). Registered roots are persisted to
`plugin-roots.json` beside the socket and reloaded on startup, so a server restarted while
the desktop is closed still resolves project-contributed agents for headless launches. The
host reads the gateway port + token from the discovery file beside the socket and passes
them in each `load` so the sidecar's `PragmaClient` resolves async model providers against
the local gateway. A load sent
before the gateway exists drops gateway-dependent agents (their model providers throw),
so the host tracks whether the last load had credentials and re-loads on the next
`catalog` read once they appear.

Desktop usage-limit refresh failures use `logUsageLimitsError`: background polling keeps
last-good data instead of raising user-facing errors, while bounded failure details remain
available in server logs.

Each server process also generates a boot id passed with the server state directory to
`pragma-plugins`. The sidecar persists plugin lifecycle markers there: `onInstall` once per
plugin id and `onPragmaLoad` once per server boot, including across catalog reloads or a
sidecar respawn. Server startup proactively loads plugins after briefly waiting for gateway
discovery, so `onPragmaLoad` does not depend on a later catalog request. Catalog load waits
up to 30s because dynamic model providers may invoke cold host CLIs; a shorter timeout leaves
load state unresolved and turns later catalog reads into a reload storm.

Watcher metadata stays server-internal because plugin config may contain secrets. Internal
action `watcher` accepts an agent id and returns matching plugin id, bundle path, config,
and local watcher agent. Headless launch ensures its mirrored project root is registered
before catalog/watcher lookup, then starts `pragma-watch` from that metadata. Registration
is idempotent and serialized with catalog reloads: parallel launches for one project trigger
at most one reload instead of flooding sidecar and gateway with duplicate model-provider work.
Catalog ids select the watcher; its plugin-local `watcherAgent` is the runtime stream id
passed as `--agentId`, matching status reports and mobile interjections.

## Workspace mirror store

`registry.rs` caches the latest `WorkspaceSnapshot` (projects/worktrees/tabs) the
desktop app publishes via `RequestKind::PublishWorkspace`. The desktop routes each
project's snapshot to its owning host. `publish_workspace` preserves daemon-owned
agent tab metadata, **persists it to `workspace.json` beside the socket** (so
headless launches survive server restarts while the app stays closed), and fans a
`Delta` carrying the full replacement snapshot to `workspace` subscribers (v1
keeps deltas trivial — every delta is a full replacement; row-level deltas are a
later optimization). `subscribe_workspace` returns the cached snapshot (or an
empty payload before the first publish) plus the delta receiver. A remote client
(e.g. a paired phone) subscribes to render the session launcher without
registering as the controller. The gateway exposes this as
`GET /v1/subscriptions/workspace`.

The mirror also enables controller-free (headless) agent launch. `agentSessionLaunch`
still brokers to desktop when connected — unless the payload sets `headless: true`,
which forces the server-side path even with a controller attached (used by
`pragma-cli agent verify` so scenario sessions never open desktop tabs). Otherwise the
server resolves agent launch metadata from the plugin catalog, spawns the PTY, and
schedules startup/prefill input. The mirrored tab is tagged with the catalog `agentId`
and display name so paired phones render an agent tab (icon) immediately. Bracketed (TUI)
prefills do not trust `prefillDelayMs`
alone: after the configured delay the launcher also waits (bounded, +15s) for the
session output to show an alternate-screen enter sequence before typing, because a
prompt typed before the TUI takes the screen is silently swallowed — concurrent cold
starts (parallel `agent verify` sessions) routinely push TUI startup past the fixed
delay. Plain-mode prefills keep the fixed-delay behavior.
A `newWorktree` spec is honored headlessly too: the server creates the git checkout at
`<project>/.pragma/worktrees/<uuid>` through the same `pragma-core` git operations the
desktop uses, then merges the new worktree + terminal tab into the mirrored snapshot
(persisted + broadcast) so the phone renders them immediately. The desktop remains the
source of truth: on its next publish it **adopts** headless-created worktrees from disk
(see `adopt_headless_worktrees` in `apps/pragma/src-tauri/src/workspace_mirror.rs`);
headless tab rows stay ephemeral until then.

`ProtocolRpcMethod::Tabs` currently owns terminal agent metadata only. `setAgent`
records the agent id and default title in the host snapshot; `listAgents` lets the
desktop overlay that durable metadata over legacy local tab rows after restart. Do
not add tab persistence back to the Tauri SQLite shell.

## Automations are project-scoped (`automations.rs`)

`discover` scans `$HOME/.pragma/automations` (global, implicitly trusted) and each
registered project's own `.pragma/automations` — **never a worktree's**. Those files
are tracked in git, so every worktree checkout holds a copy of them; scanning
worktrees gave each copy its own id (the id is a hash of the path) and so re-asked
for approval of source the user had already approved, once per worktree created. It
also multiplied the 5s scan and the loaded-automation set by the worktree count.
`AutomationInfo.worktreeId` / `worktreeLabel` are therefore always `null`.

## Fanout orchestration (`fanouts.rs`, `fanout_host.rs`)

A fanout runs one prompt in N isolated attempt worktrees under a single parent,
then merges one of them back. The record is **host-owned and persisted**, so it
behaves identically whether the desktop is open, closed, or restarting — the
desktop subscribes and controls, it never owns the process.

The module is split so the rules can be tested without git or PTYs:

- `fanouts.rs` holds `FanoutStore` (durable record, state machine,
  subscriptions, ordering, and the destructive pick transaction), generic over
  the `FanoutHost` seam. `fanouts/tests.rs` exercises every rule against an
  in-memory fake host.
- `fanout_host.rs` implements `FanoutHost` for `Registry`: git through
  `pragma-core`, sessions through the shared launch primitive, the plugin
  catalog, and the `pragma-ai` commit-message sidecar.

Invariants worth keeping:

- **One parent, at most one active fanout.** A completed, cancelled, or failed
  fanout releases its parent; anything else — including one parked mid-finalize
  — still owns it.
- **Every attempt branches from one captured commit.** `baseCommit` is read at
  creation and used by `CreateWorktreeAt` for every attempt and by every
  comparison diff, so the columns stay comparable after the parent moves on.
  A dirty parent is refused: git worktrees inherit commits, not uncommitted
  bytes.
- **Preflight before side effects.** Selectors, models, and reasoning ids all
  resolve against the _target project's_ catalog before a single worktree
  exists. A partly-provisioned fanout keeps its healthy attempts, goes
  `partial`, and exposes per-member `retry`.
- **The state file is owner-only and atomic.** `fanouts.json` beside the socket:
  temp file via `pragma_platform::perms::create_private_file`, flush, rename,
  restrict. Prompts can carry sensitive context and are never logged.
- **A restart never replays a prompt.** Live members become `interrupted`; the
  attempt worktree may already hold work, so only an explicit `retry` relaunches
  it (into the same worktree, with the old tab id moved into history).
- **Pick is ordered so nothing is destroyed before the work is safe:** commit
  the winner (AI message, never a fabricated fallback) → merge → promote
  scratchpads → stop sessions → delete every attempt, winner included. Each
  completed step is persisted as a `FanoutFinalizeStage`, so a retry resumes at
  the first incomplete one instead of repeating a destructive step. A merge
  conflict parks at `needsResolution` with everything intact; a partial cleanup
  reports `cleanupFailed` and the exact survivors, never `completed`.

**Follow-up delivery has no harness-level acknowledgement yet.** `deliver_message`
reports `delivered` when the input reached the live watcher for that exact
`(worktreeId, tabId, agent)` triple — not that the TUI typed and submitted it.
Message ids make a retry idempotent on this side. A real ACK needs the watcher
protocol to report back.

## Socket And Access Control

- The socket filename comes from `@pragma/constants` (`daemon.socketFile`, still
  `daemon.sock`) so SSH `direct-streamlocal` forwards
  the same path.
- The socket is restricted to its owner by `pragma_platform::ipc::bind` — `0600` on
  Unix, an owner-only ACL on Windows. Filesystem permissions are the access control
  boundary on every platform; there is no in-band auth.
- Do not add TCP, TLS, pairing, tokens, or a custom auth layer.
- The HTTP gateway is deliberately separate (`crates/pragma-gateway`): SDKs talk HTTP
  to the gateway, and the gateway talks to this server over the existing Unix socket.
  Server invariants stay unchanged.
- SSH is client-side only. The server must not know SSH exists.
- `--relay` is the one exception to "the server only listens": it makes the process a
  stdio pipe to an already-running server's socket instead of starting one. A Windows
  client runs it _inside_ a WSL distribution through `wsl.exe` to reach the Linux server
  there, because WSL2 and Windows cannot share a socket or a pipe. It interprets nothing
  — framing stays in `pragma-protocol` — and the socket keeps its owner-only permissions
  and remains the only entry point, so agent plugins inside the distribution connect to
  it exactly as they do on a native Linux host. Covered by `tests/relay.rs`.

## One Server Per Channel

Startup enforces this with two checks that cover each other's blind spot. Do not
weaken either, and in particular **do not add code that deletes the lock file** —
that is precisely what caused the bug this replaced.

1. **`flock` on `server.lock`** (`acquire_lock`). An advisory lock, not the mere
   existence of the file: the kernel releases it when the holder exits, so a crashed
   server never leaves a lock needing cleanup, and a second server starting
   concurrently is refused.
2. **A liveness probe of `daemon.sock`** (`take_socket_path`). An `flock` guards a
   file, not a path, so anything that unlinks the lock lets the next process create
   and lock a fresh one. A server that is genuinely serving still answers on its
   socket regardless — that is the evidence that survives. A socket file nobody
   answers on is debris from a killed server and is unlinked.

The previous existence-based lock (`create_new`) had to treat a leftover file as a
running server, which meant it needed stale-file cleanup, which deleted the lock of a
winner that had not yet bound its socket. Both processes then bound, and the loser
kept running forever with PTYs, watchers, and sidecars attached — burning its own
`RLIMIT_NOFILE` budget and re-running every automation. Three such servers were found
alive at once.

Deliberate replacement still works because the app kills the old server before
spawning a new one (`kill_stale_server` in `pragma-client`), so nothing answers the
probe by then. Replacement kills the server's complete descendant tree, not only its
pid: Bun plugin/automation hosts, per-agent watchers, PTYs, and tunnel processes must
not be reparented as orphans. As a second line of defense, long-lived Bun hosts treat
supervisor stdin EOF as a cleanup-and-exit signal. The client never unlinks `server.lock`;
the kernel releasing its advisory lock is what makes replacement safe.

## Wire Protocol

Terminal output is raw bytes end-to-end. Every frame is:

```text
[4-byte BE length][1-byte tag][body]
```

- Tag `0` = JSON control/RPC/event frame.
- Tag `1` = binary output frame:
  `[2-byte BE session-id length][session id][raw output bytes]`.
- Tag `2` = binary input frame:
  `[2-byte BE session-id length][session id][raw input bytes]`.

`FRAME_TAG_OUTPUT`, `FRAME_TAG_INPUT`, `write_output_frame`, and `write_input_frame`
are load-bearing. Never route PTY input/output through JSON, and never decode UTF-8 on
the hot path. Input remains fire-and-forget, but `Registry::write_bytes` failures must be
logged with session context instead of discarded; do not add per-keystroke responses.

## Lifecycle

The server is persistent. Do not reintroduce empty-idle self-exit behavior.
Lifecycle is owned by a host service manager or client-side bootstrap.

## Stability invariants

The release profile builds with `panic = "abort"`, so a panic on **any** thread
kills every session at once. These invariants exist so long-running servers
neither balloon in memory nor wedge on a dead client — keep them when touching
session/connection code:

- **All per-session memory is byte-bounded.** Scrollback is capped by frame
  count _and_ total output bytes (`SCROLLBACK_MAX_BYTES`); a frame-count cap
  alone is not a bound because coalesced frames are up to 256 KiB each.
- **Filesystem deltas are advisory and bounded.** Each file subscriber has a small bounded
  queue; a full queue drops redundant invalidations rather than blocking the OS watcher or
  growing memory. Last-listener teardown drops the recursive watcher.
- **Every write to a client socket is timeout-bounded** (`CLIENT_WRITE_TIMEOUT`
  via `SO_SNDTIMEO`). A client that stops draining must never pin a thread (or
  the writer mutex it holds) forever, and must not let its unbounded subscriber
  channel grow while the session keeps producing output.
- **Terminal reconnects are cursor-based.** Each attach begins with a `Replay` event carrying
  the absolute output-byte cursor. A valid cursor replays only missing bytes; a cursor older than
  retained scrollback sets `reset`, making full bounded replay exceptional rather than a loop.
  Keep cursor snapshot and subscriber registration under the scrollback lock.
- **Input never queues through output coalescing.** PTY input writes directly to the PTY writer;
  do not enqueue a flush marker first. The coalescer already flushes isolated echo immediately and
  within 8ms during a burst, while a bounded output queue must never delay keyboard or wheel input.
- **Never keep writing after a failed write.** A timed-out write may have left
  a partial frame on the wire; the connection's framing is untrustworthy and it
  must be shut down (`write_or_hang_up` / `write_frame_or_hang_up`).
- **Exited sessions remove themselves through a weak registry callback** after
  recording their final `Exit` frame, including when no client is attached.
  Live event forwarding and scrollback replay also call
  `Registry::remove_exited` defensively; all paths are idempotent.

## Agent Status

The server keeps runtime-only agent status keyed by `(worktreeId, tabId, agent)`.
Shell sessions export both `PRAGMA_SERVER_SOCKET` and the legacy
`PRAGMA_DAEMON_SOCKET` so existing plugins keep working while clients migrate to
`pragma-cli`. Production exports `PRAGMA_CLI=$HOME/.local/bin/pragma-cli`; dev channels
use isolated `<PRAGMA_APP_DATA_DIR>/bin/pragma-cli` so concurrent worktrees never share
stale helper binaries. The matching directory is prepended to `PATH`.

Command-approval decisions are broadcast on the same agent stream and kept only in a
short bounded replay window, so a watcher that starts/subscribes just after the toast
click still sees the verdict without making approvals durable state.

Free-form `AgentInput` always uses watcher delivery because each agent owns its TUI-specific
submit keys and timing.

## Watcher supervision (`watchers.rs`)

This server owns one `pragma-watch` sidecar per live agent session, because it owns the
sessions. `WatcherSupervisor::reconcile` re-derives the desired set — every live session
whose mirrored tab records an `agentId`, plus plain terminal tabs with one unambiguous
runtime agent report — and starts what is missing, stops what is no longer wanted, and
replaces what is stale. Runtime matching uses plugin-local `watcherAgent` only when unique;
otherwise no watcher starts. It runs on a timer (`RECONCILE_INTERVAL`, 5s), directly after
a headless launch or workspace publish, and after a manually started agent's first report.

A timer rather than a spawn hook, because the three ways a watcher goes bad are all
invisible as events:

- **The desktop restarted or reloaded plugins.** Watchers used to be desktop children
  torn down on every plugin-contribution refresh, orphaning every running agent.
- **The gateway restarted.** It binds an **ephemeral** port, so every already-running
  watcher holds a dead `--gatewayUrl` and reconnects to nothing, forever. The
  supervisor stores each watcher's credentials and replaces any that no longer match
  the discovery file.
- **The watcher itself exited** (bad bundle, crash). Short-lived exits are logged and
  retried with exponential backoff (5s → 5m) so a broken plugin cannot hot-loop.

Nothing else may spawn `pragma-watch`: two watchers on one session type every
interjection twice.

## Port Inventory

`ProtocolRpcMethod::Ports` returns TCP listeners attributable to requested worktrees. Each
session records its root shell PID; `ports.rs` walks current process ancestry and accepts only
that shell or descendants before joining listener PIDs to tab/worktree ids. This ancestry
filter is the security and UX boundary: never return unattributed host listeners, Pragma
internals, or daemonized processes reparented outside the tab's process tree.
