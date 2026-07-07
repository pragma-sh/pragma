# crates/pragma-server - Persistent Host Server

`pragma-server` owns host-side runtime state and listens on a `0600` Unix socket
only. It replaces the old `pragma-daemon` name while preserving the existing PTY,
scrollback, raw output, and agent-status strengths.

## Responsibilities

- Spawning and managing PTY sessions.
- Coalescing and broadcasting PTY output.
- Tracking runtime agent status in memory.
- Serving `pragma-core` RPC and snapshot-then-delta event subscriptions over the
  existing length-prefixed frame codec.
- Spawning host-side sidecars (`pragma-ai`, `pragma-github`, `pragma-automations`).

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
