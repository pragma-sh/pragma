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

## Instance channel helpers

`pragma_protocol::dev_channel(workspace_root)` — deterministic hash of the absolute
workspace root path; used by both the app and daemon to compute the `pragma-dev-<hash>`
channel for dev builds.

`PROD_CHANNEL` — the stable `"pragma"` channel for production builds.

Both live here so the app and daemon always compute identical channels without circular
dependencies.

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
