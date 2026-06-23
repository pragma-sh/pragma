# crates/pragma-protocol — Shared Wire Protocol

Shared wire frame definitions and framing utilities used by the daemon, the Tauri app,
and `pragma-agent`. This is the one crate all three share.

## Frame format

Every frame: `[4-byte BE length][1-byte tag][body]`

| Tag | Type   | Body format                                                       |
| --- | ------ | ----------------------------------------------------------------- |
| 0   | JSON   | Control frame: hello, requests, responses, title/exit events      |
| 1   | Binary | `[2-byte BE session-id length][session id bytes][raw PTY output]` |

Helpers: `write_output_frame` / `Frame::Output` (write); `Frame::read` (read).

## Instance channel helpers

`pragma_protocol::dev_channel(workspace_root)` — deterministic hash of the absolute
workspace root path; used by both the app and daemon to compute the `pragma-dev-<hash>`
channel for dev builds.

`PROD_CHANNEL` — the stable `"pragma"` channel for production builds.

Both live here so the app and daemon always compute identical channels without circular
dependencies.

## Rules

- Any change to the frame layout, tag values, or the binary output format **must** bump
  `daemon.protocolVersion` in `packages/constants/values.json`. See
  `crates/pragma-daemon/AGENTS.md`.
- The app must **never** re-encode PTY output — relay `Vec<u8>` bytes straight through
  as `InvokeResponseBody::Raw`.
- `EventFrame::Output` holds `Vec<u8>` — there is no UTF-8 decode on the hot path;
  xterm reassembles any multi-byte sequence split across frames itself.
