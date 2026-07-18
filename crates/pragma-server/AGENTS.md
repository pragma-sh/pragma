# crates/pragma-server - Persistent Host Server

`pragma-server` owns host-side runtime state and listens on a `0600` Unix socket
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
  `pragma-plugins`).
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

Each server process also generates a boot id passed with the server state directory to
`pragma-plugins`. The sidecar persists plugin lifecycle markers there: `onInstall` once per
plugin id and `onPragmaLoad` once per server boot, including across catalog reloads or a
sidecar respawn. Server startup proactively loads plugins after briefly waiting for gateway
discovery, so `onPragmaLoad` does not depend on a later catalog request.

Watcher metadata stays server-internal because plugin config may contain secrets. Internal
action `watcher` accepts an agent id and returns matching plugin id, bundle path, config,
and local watcher agent. Headless launch registers its mirrored project root through
`registerRoots` before catalog/watcher lookup, then starts `pragma-watch` from that metadata.
Catalog ids select the watcher; its plugin-local `watcherAgent` is the runtime stream id
passed as `--agentId`, matching status reports and mobile interjections.

## Workspace mirror store

`registry.rs` caches the latest `WorkspaceSnapshot` (projects/worktrees/tabs) the
desktop app publishes via `RequestKind::PublishWorkspace`. `publish_workspace`
replaces the cache, **persists it to `workspace.json` beside the socket** (so
headless launches survive server restarts while the app stays closed), and fans
a `Delta` carrying the full replacement snapshot to `workspace` subscribers (v1
keeps deltas trivial — every delta is a full replacement; row-level deltas are a
later optimization). `subscribe_workspace` returns the cached snapshot (or an
empty payload before the first publish) plus the delta receiver. A remote client
(e.g. a paired phone) subscribes to render the session launcher without
registering as the controller. The gateway exposes this as
`GET /v1/subscriptions/workspace`.

The mirror also enables controller-free (headless) agent launch. `agentSessionLaunch`
still brokers to desktop when connected; otherwise the server resolves agent launch
metadata from the plugin catalog, spawns the PTY, and schedules startup/prefill input.
A `newWorktree` spec is honored headlessly too: the server creates the git checkout at
`<project>/.pragma/worktrees/<uuid>` through the same `pragma-core` git operations the
desktop uses, then merges the new worktree + terminal tab into the mirrored snapshot
(persisted + broadcast) so the phone renders them immediately. The desktop remains the
source of truth: on its next publish it **adopts** headless-created worktrees from disk
(see `adopt_headless_worktrees` in `apps/pragma/src-tauri/src/workspace_mirror.rs`);
headless tab rows stay ephemeral until then.

## Socket And Access Control

- The socket filename remains `daemon.sock` so SSH `direct-streamlocal` forwards
  the same path.
- The socket mode is explicitly set to `0600`; Unix filesystem permissions are
  the access control boundary.
- Do not add TCP, TLS, pairing, tokens, or a custom auth layer.
- The HTTP gateway is deliberately separate (`crates/pragma-gateway`): SDKs talk HTTP
  to the gateway, and the gateway talks to this server over the existing Unix socket.
  Server invariants stay unchanged.
- SSH is client-side only. The server must not know SSH exists.

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
the hot path.

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
- **Every write to a client socket is timeout-bounded** (`CLIENT_WRITE_TIMEOUT`
  via `SO_SNDTIMEO`). A client that stops draining must never pin a thread (or
  the writer mutex it holds) forever, and must not let its unbounded subscriber
  channel grow while the session keeps producing output.
- **Never keep writing after a failed write.** A timed-out write may have left
  a partial frame on the wire; the connection's framing is untrustworthy and it
  must be shut down (`write_or_hang_up` / `write_frame_or_hang_up`).
- **Exited sessions are reaped wherever their `Exit` frame is observed** — on
  the live event path _and_ on scrollback replay (`Registry::remove_exited`),
  so a session that dies while no client is attached is cleaned up on the next
  attach instead of leaking its PTY fd and scrollback.

## Agent Status

The server keeps runtime-only agent status keyed by `(worktreeId, tabId, agent)`.
Shell sessions export both `PRAGMA_SERVER_SOCKET` and the legacy
`PRAGMA_DAEMON_SOCKET` so existing plugins keep working while clients migrate to
`pragma-cli`. They also export `PRAGMA_CLI=$HOME/.local/bin/pragma-cli` and prepend that
directory to `PATH` so plugins can find the helper even when the user's login shell omits
`~/.local/bin`.

Command-approval decisions are broadcast on the same agent stream and kept only in a
short bounded replay window, so a watcher that starts/subscribes just after the toast
click still sees the verdict without making approvals durable state.

Free-form `AgentInput` always uses watcher delivery because each agent owns its TUI-specific
submit keys and timing. Headless launches start their watcher from `watchers.rs`, so mobile
replies keep working without a desktop-started watcher process.

## Port Inventory

`ProtocolRpcMethod::Ports` returns TCP listeners attributable to requested worktrees. Each
session records its root shell PID; `ports.rs` walks current process ancestry and accepts only
that shell or descendants before joining listener PIDs to tab/worktree ids. This ancestry
filter is the security and UX boundary: never return unattributed host listeners, Pragma
internals, or daemonized processes reparented outside the tab's process tree.
