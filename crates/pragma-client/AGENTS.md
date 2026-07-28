# crates/pragma-client - Native Client Transport

Rust client library used by the Tauri app and future CLI code. It owns frame I/O,
local/remote connection decisions, and the SSH streamlocal bridge.

## Responsibilities

- Synchronous frame I/O over a local `AF_UNIX` socket (macOS, Linux, **and** Windows —
  see `crates/pragma-platform`) for PTY, RPC, and subscriptions.
- Bridges that present something remote as a local socket: SSH streamlocal for remote
  hosts (`ssh.rs`), and a `wsl.exe` stdio relay for WSL distributions (`wsl.rs`). Both
  share the accept/pump machinery in `bridge.rs`.
  `PragmaClient::rpc(method, payload)` is the single entry for the host
  business-logic methods (`filesystem`, `git`); `server_protocol_version()`
  reads the `Hello` frame to verify a remote server before routing to it.
  Requests/RPCs check a connection out of a small idle pool
  (`REQUEST_POOL_MAX_IDLE`) so concurrent calls run in parallel on their own
  connections — never funnel them back through one shared stream, or file
  reads and diffs will queue behind slow git polls again. RPC response reads
  have no deadline while host work is active because operations such as a
  user-defined `git push` hook may run long; the normal timeout is restored before the
  connection returns to the pool. Brokered control requests use the same unbounded wait:
  retrying an `agentSessionLaunch` after a 5s socket timeout can duplicate a launch that
  already succeeded server-side.
- Local managed-server bootstrap for development and packaged native clients.
- Remote SSH bridge using `russh` and `channel_open_direct_streamlocal`, with
  agent (default), key-file, and password auth (`RemoteAuth`). `ssh_exec` runs
  one-shot remote commands (path/git/version probing) over a fresh session,
  separate from the long-lived bridge.
- Keeping SSH async code quarantined in this crate; callers above the seam keep
  using synchronous `UnixStream` frame code.
- Client-local router DB mapping projects to hosts plus device-local preferences.
  The desktop app's `Hosts` registry owns this DB and resolves each project to
  its host client. SSH routes persist only non-secret connection preferences so
  the app can reconnect agent-authenticated remotes on startup.

## Cargo features

- Default features are `ssh` and `router`, matching the desktop app's full native
  client needs.
- `ssh` gates the `russh`/`tokio` SSH streamlocal bridge and remote exec helpers.
- `router` gates the `rusqlite` client-local router database.
- `cargo build -p pragma-client --no-default-features` must keep compiling for
  lightweight consumers such as `pragma-gateway`, which only need Unix-socket frame I/O.

## Rules

- No TCP listener, TLS, pairing, tokens, or custom auth layer.
- Remote access forwards the remote `daemon.sock`; `pragma-server` does not know
  SSH exists.
- Do not parse or reframe PTY output in the bridge. It copies raw socket bytes.
- Keep terminal output on `write_output_frame` / binary frame fast path.
- Keep terminal input on `write_input_frame` / binary fire-and-forget fast path. Do not
  reintroduce per-keystroke JSON requests or response draining.
