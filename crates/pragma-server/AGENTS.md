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
- Spawning host-side sidecars (`pragma-ai`, later fully `pragma-github`).

## Socket And Access Control

- The socket filename remains `daemon.sock` so SSH `direct-streamlocal` forwards
  the same path.
- The socket mode is explicitly set to `0600`; Unix filesystem permissions are
  the access control boundary.
- Do not add TCP, TLS, pairing, tokens, or a custom auth layer.
- SSH is client-side only. The server must not know SSH exists.

## Wire Protocol

Terminal output is raw bytes end-to-end. Every frame is:

```text
[4-byte BE length][1-byte tag][body]
```

- Tag `0` = JSON control/RPC/event frame.
- Tag `1` = binary output frame:
  `[2-byte BE session-id length][session id][raw output bytes]`.

`FRAME_TAG_OUTPUT` and `write_output_frame` are load-bearing. Never route PTY
output through JSON, and never decode UTF-8 on the hot path.

## Lifecycle

The server is persistent. Do not reintroduce empty-idle self-exit behavior.
Lifecycle is owned by a host service manager or client-side bootstrap.

## Agent Status

The server keeps runtime-only agent status keyed by `(worktreeId, tabId, agent)`.
Shell sessions export both `PRAGMA_SERVER_SOCKET` and the legacy
`PRAGMA_DAEMON_SOCKET` so existing plugins keep working while clients migrate to
`pragma-cli`.
