# crates/pragma-daemon — Detached PTY Daemon

The daemon owns all shell sessions and PTY I/O. It runs as a detached Unix-socket
server; the Tauri app only proxies over the socket and must not own PTYs.

## Responsibilities

- Spawning and managing shell sessions (PTY master/slave pairs)
- Coalescing and broadcasting PTY output
- Parsing OSC title sequences from the PTY stream
- Tracking runtime agent status in memory
- Serving the wire protocol to the Tauri app and `pragma-agent` CLI

## PTY output coalescing

The PTY master is read in 64 KB chunks (`READ_BUFFER_BYTES`). A dedicated coalescer
thread (`Session::start_coalescer` in `src/session.rs`) merges consecutive `Output`
frames on a **trailing throttle** (`OUTPUT_COALESCE_INTERVAL`, 8 ms): the first output
after an idle gap flushes immediately (zero added keystroke-echo latency); back-to-back
output is batched — flushed at most once per interval or sooner at
`OUTPUT_COALESCE_MAX_BYTES` (256 KB). `Title`/`Exit` flush pending output first so
ordering is preserved.

Changing the coalescing/buffering **requires bumping `daemon.protocolVersion`** (see
below).

## Wire protocol

Terminal output is shipped as **raw bytes end-to-end — never JSON**. Every frame is
`[4-byte BE length][1-byte tag][body]`:

- **Tag 0** = JSON control frame (hello, requests, responses, title/exit events)
- **Tag 1** = binary output frame: `[2-byte BE session-id length][session id][raw output bytes]`

Output crosses the socket without JSON escaping (which expands each `0x1B` ~6x) and
without any UTF-8 decode — `EventFrame::Output` holds `Vec<u8>`. The app relays the
daemon's bytes straight through as `InvokeResponseBody::Raw`, received in JS as an
`ArrayBuffer`. See `crates/pragma-protocol/AGENTS.md` for frame definitions.

Any change to the frame layout, tag values, or channel payload types **must** bump
`daemon.protocolVersion`.

## Protocol version handshake

The daemon is **detached and long-lived** — a rebuild does not restart it. A stale
daemon keeps serving over the existing socket and new daemon code never runs.

The daemon greets every connection with `ServerFrame::Hello { protocolVersion }` (first
frame, always) and records its PID in `daemon.lock`. The app's `connect_compatible`
(`apps/pragma/src-tauri/src/pty.rs`) reads that hello and, on a version mismatch **or
no greeting** (old pre-handshake daemon), kills the stale process (by lock-file PID,
falling back to `pkill`) and respawns a matching one.

The version is `@pragma/constants` `daemon.protocolVersion` — **bump it whenever you
change the daemon wire protocol or PTY-stream handling** (e.g. the OSC title parser).
Both the daemon and the app crates read it from
`pragma_constants::CONSTANTS.daemon.protocol_version`.

**Current protocol version: 6** (latest wire change: `MarkAgentsSeen` request).

## Agent status

The daemon keeps runtime-only agent status in memory keyed by `(worktreeId, tabId,
agent)`. It supports:

- A long-lived `SubscribeAgents` request for the app (emits `EventFrame::Agent`
  snapshots/events)
- A `MarkAgentsSeen` request (`mark_agents_seen_for_tab`) that drops a tab's **`done`**
  entries (leaving `running`/`attention`) once the user has viewed the tab
- Replay: `agent_events.rs` re-subscribes on any disconnect, re-emitting
  `pragma:agent-status-reset` + the full snapshot

Status is never persisted to SQLite. `cleared` removes the entry from the in-memory map
and broadcasts so live subscribers drop the indicator and a reconnecting subscriber's
snapshot omits it.

Sessions inject `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, and `PRAGMA_DAEMON_SOCKET` into
the shell environment so `pragma-agent` can connect and report status.

## Instance channel (daemon side)

The app hands the channel to the spawned daemon via `PRAGMA_DAEMON_CHANNEL` +
`PRAGMA_APP_DATA_DIR` env vars. `crates/pragma-daemon/src/main.rs` (`daemon_channel` →
`daemon_paths`) reads those env vars, falling back to `default_daemon_channel` (same
`dev_channel(workspace_root)` for a debug build, `PROD_CHANNEL` for release) only when
run by hand — so `cargo run -p pragma-daemon` in a worktree serves that worktree's app.

On Linux the daemon socket/lock/log live in `$XDG_RUNTIME_DIR/<channel>`; elsewhere
`<app_data_dir>/<channel>`. The `daemon.log` is beside the socket (not app data).

## OSC title parsing

The daemon strips `OSC 0` / `OSC 2` (`ESC ]0/2;…BEL/ST`) out of the raw PTY stream in
`src/session.rs` and emits a `Title` event. Changing this parsing requires bumping the
protocol version.
