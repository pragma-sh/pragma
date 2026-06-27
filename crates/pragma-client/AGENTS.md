# crates/pragma-client - Native Client Transport

Rust client library used by the Tauri app and future CLI code. It owns frame I/O,
local/remote connection decisions, and the SSH streamlocal bridge.

## Responsibilities

- Synchronous frame I/O over Unix sockets for PTY, RPC, and subscriptions.
- Local managed-server bootstrap for development and packaged native clients.
- Remote SSH bridge using `russh` and `channel_open_direct_streamlocal`.
- Keeping SSH async code quarantined in this crate; callers above the seam keep
  using synchronous `UnixStream` frame code.
- Client-local router DB mapping projects to hosts plus device-local preferences.

## Rules

- No TCP listener, TLS, pairing, tokens, or custom auth layer.
- Remote access forwards the remote `daemon.sock`; `pragma-server` does not know
  SSH exists.
- Do not parse or reframe PTY output in the bridge. It copies raw socket bytes.
- Keep terminal output on `write_output_frame` / binary frame fast path.
