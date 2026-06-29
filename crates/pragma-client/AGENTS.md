# crates/pragma-client - Native Client Transport

Rust client library used by the Tauri app and future CLI code. It owns frame I/O,
local/remote connection decisions, and the SSH streamlocal bridge.

## Responsibilities

- Synchronous frame I/O over Unix sockets for PTY, RPC, and subscriptions.
  `PragmaClient::rpc(method, payload)` is the single entry for the host
  business-logic methods (`filesystem`, `git`); `server_protocol_version()`
  reads the `Hello` frame to verify a remote server before routing to it.
- Local managed-server bootstrap for development and packaged native clients.
- Remote SSH bridge using `russh` and `channel_open_direct_streamlocal`, with
  agent (default), key-file, and password auth (`RemoteAuth`). `ssh_exec` runs
  one-shot remote commands (path/git/version probing) over a fresh session,
  separate from the long-lived bridge.
- Keeping SSH async code quarantined in this crate; callers above the seam keep
  using synchronous `UnixStream` frame code.
- Client-local router DB mapping projects to hosts plus device-local preferences.
  The desktop app's `Hosts` registry owns this DB and resolves each project to
  its host client.

## Rules

- No TCP listener, TLS, pairing, tokens, or custom auth layer.
- Remote access forwards the remote `daemon.sock`; `pragma-server` does not know
  SSH exists.
- Do not parse or reframe PTY output in the bridge. It copies raw socket bytes.
- Keep terminal output on `write_output_frame` / binary frame fast path.
