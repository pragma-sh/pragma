# crates/pragma-protocol — Shared Wire Protocol

Shared wire frame definitions and framing utilities used by `pragma-server`, native
clients, and `pragma-cli`. This is the one crate all Rust protocol participants share.

## Frame format

Every frame: `[4-byte BE length][1-byte tag][body]`

| Tag | Type   | Body format                                                       |
| --- | ------ | ----------------------------------------------------------------- |
| 0   | JSON   | Control frame: hello, requests, responses, RPC, events            |
| 1   | Binary | `[2-byte BE session-id length][session id bytes][raw PTY output]` |
| 2   | Binary | `[2-byte BE session-id length][session id bytes][raw PTY input]`  |

Helpers: `write_output_frame` / `write_input_frame` (write); `read_frame` / `Frame`
(read).

Terminal event streams start with JSON `EventFrame::Replay { sessionId, cursor, reset }`.
`cursor` is the absolute count of raw output bytes before following binary output; reconnecting
clients send their last accepted cursor on `Attach`. `reset` means retained scrollback cannot cover
the requested cursor. Protocol version 21 introduced this contract without changing binary layout.

## Instance channel helpers

`pragma_protocol::dev_channel(workspace_root)` — deterministic hash of the absolute
workspace root path; used by both the app and daemon to compute the `pragma-dev-<hash>`
channel for dev builds.

`PROD_CHANNEL` — the stable `"pragma"` channel for production builds.

Both live here so the app and daemon always compute identical channels without circular
dependencies.

## Process limits

`pragma_protocol::limits::raise_open_file_limit()` — raises this process's
`RLIMIT_NOFILE` soft limit toward 65 536, capped at the hard limit. Only ever raises,
so it is safe to call from a process that already has a higher limit.

**Every host process must call this before it opens anything or spawns a child.**
macOS `launchd` gives a GUI app a soft limit of **256**, and Rust — unlike Node/Bun —
never raises it on its own. That ceiling is inherited by `pragma-server`, the gateway,
every sidecar, and every shell in a terminal tab, so a session with many tabs (or a
test suite running inside one) exhausts it: the server logs
`accept failed: Too many open files (os error 24)` and then cannot accept another
connection until an existing one closes, which reads as a total, permanent freeze.
Children inherit the limit in force when they are spawned, so the call has to come
first.

Current callers: `pragma-server`, `pragma-gateway`, and the app's `run()`. It lives
here rather than in `pragma-core` because this is the one crate every host process
already depends on.

## Rules

- Any change to the frame layout, tag values, or the binary input/output format **must** bump
  `daemon.protocolVersion` in `packages/constants/values.json`. See
  `crates/pragma-server/AGENTS.md`.
- The app must **never** re-encode PTY output — relay `Vec<u8>` bytes straight through
  as `InvokeResponseBody::Raw`.
- Terminal input must stay on `write_input_frame`'s fire-and-forget binary path; do not
  reintroduce per-keystroke JSON request/response frames.
- `EventFrame::Output` holds `Vec<u8>` — there is no UTF-8 decode on the hot path;
  xterm reassembles any multi-byte sequence split across frames itself.
