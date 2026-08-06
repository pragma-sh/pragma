# crates/pragma-gateway - Local HTTP Gateway

`pragma-gateway` exposes a localhost-only HTTP/JSON API in front of the existing
`pragma-server` Unix-socket frame protocol.

## Responsibilities

- Bind only to `127.0.0.1`, normally on an ephemeral port.
- Write `gateway.json` beside `daemon.sock` with `{ port, token, pid, protocolVersion }`
  using mode `0600`.
- Begin serving HTTP immediately after writing `gateway.json`. Post-discovery work such
  as plugin catalog refresh must run in background; model providers may take seconds and
  must not leave an advertised gateway unable to accept requests.
- Persist the bearer token in an owner-only `gateway-token` file beside `daemon.sock`
  (`0600` on Unix, an owner-only ACL on Windows — always via `pragma_platform::perms`)
  when `--token` is absent: read it if present, otherwise generate and write it. This
  keeps the token stable across gateway restarts so paired remote devices are not
  disconnected on every respawn. The desktop `regenerate_gateway_token` command deletes
  this file (and kills the gateway) to force a fresh token. `--token` still overrides.
- Persist authenticated mobile installation metadata in `gateway-devices.json` beside
  `daemon.sock`. Mobile sends installation-scoped identity headers on every request;
  gateway updates first/last-seen timestamps only after bearer authentication.
- On startup, refuse if a live gateway with the **same** protocol version already serves
  the discovery file; a live gateway with a **different** protocol version (leftover from
  a previous app build) is killed and replaced — otherwise a protocol bump deadlocks
  every future gateway start (the app rejects the mismatched `gateway.json`, spawns a new
  gateway, and the new gateway refuses because the old one still answers `/v1/health`).
- Require `Authorization: Bearer <token>` for every route except `GET /v1/health`.
- Translate HTTP requests to existing `pragma-client` calls over the Unix socket.
- Stream session, agent, and subscription events as NDJSON. Do not use SSE or WebSockets.
- NDJSON streams begin with a `{"type":"ready"}` heartbeat so fetch clients resolve the
  response and install readers before the first real daemon event arrives.

## Route Table

- `GET /v1/health` - no auth, gateway-local status.
- `GET /v1/version` - gateway/protocol version.
- `POST /v1/rpc/{method}` - pass-through RPC for known `ProtocolRpcMethod` names.
- `POST /v1/sessions` - spawn a PTY session.
- `GET /v1/sessions/{id}/events` - attach and stream session events.
- `POST /v1/sessions/{id}/input` - raw octet-stream PTY input.
- `POST /v1/sessions/{id}/resize` - resize a PTY.
- `DELETE /v1/sessions/{id}` - kill a PTY.
- `DELETE /v1/sessions?cwd=...` - kill PTYs rooted at a cwd.
- `POST /v1/agents/reports` - agent status report.
- `POST /v1/agents/{messages,decisions,answers,inputs,interrupts}` - publish an agent
  message / a command-approval verdict / a question reply / a free-form interjection / a
  transient interrupt; all fanned out to agent-event subscribers. Interrupts carry no
  replay buffer (best-effort to live watchers).
- `GET /v1/agents/events` - stream agent status events.
- `POST /v1/tabs/{tabId}/agents/seen` - mark done agents seen.
- `GET /v1/subscriptions/{event}` - stream protocol snapshots and deltas.
- `POST /v1/push/tokens` - register (or refresh) a phone's Expo push token.
- `DELETE /v1/push/tokens` - stop pushing to that installation (unpair).
- `GET /v1/push/tokens` - list phones registered for push.
- `POST /v1/push/test` - send a test notification to every registered phone.
- `POST /v1/push/presence` - desktop focus heartbeat; suppresses pushes while focused.
- `GET /v1/theme?root=...` - the user's merged `.pragma/theme.json` color overrides.

## Theme

`routes/theme.rs` serves the same layering the desktop applies: global
(`~/.pragma/theme.json`) then, when `root` names an absolute project path, that
project's file. Three rules keep it honest:

- **Only user overrides go over the wire, never shipped defaults.** The desktop's
  defaults are parsed from `apps/pragma/src/index.css` and are not another client's
  defaults — a mobile client layers what it gets on top of its own palette.
- **Reads go through the host `filesystem` RPC** (`Client::read_text_file`), not
  gateway-local `std::fs`. Containment stays in `pragma-core`, and a remote host's
  files are not on the gateway's disk. The global scope's home directory is also
  resolved on the host (`FsRequest::HomeDir` via `Client::home_dir`), never on the
  gateway: reached through an SSH streamlocal bridge, the gateway machine's home
  is a different user's, so a locally resolved path would drop the remote user's
  theme or read an unrelated coincidentally matching file.
- **Unknown shapes are dropped, not rejected.** Modes come from
  `CONSTANTS.theme.modes` and only string entries under `colors.<mode>` survive, so a
  hand-edited or newer theme file still themes what the client understands.

## Push notifications

The gateway is the process a phone talks to, so it is also the process that pushes
to it (`src/push/`). Two background threads start with the gateway and reconnect
forever: one mirrors the desktop's `workspace` snapshot (to turn ids into project /
worktree / tab names), one reads the agent status stream and delivers.

- **Registration lives on the device record.** A push token is one more field on the
  `gateway-devices.json` entry keyed by `x-pragma-device-id`, so it inherits the
  owner-only file and the existing identity. `record()` must copy the push fields
  forward — headers do not carry them, and rewriting the record from headers alone
  would silently unsubscribe the phone on the next request.
- **The latch mirrors the desktop's.** The host replays its whole status snapshot on
  every reconnect, so a report is pushed only when its status differs from the last one
  pushed for that worktree+tab+agent (+`requestId` for a command approval). `running`
  and `cleared` release it.
- **Desktop focus suppresses.** While a heartbeat newer than `gateway.push.presenceTtlMs`
  says a desktop window is focused, nothing is pushed — the user is already reading the
  toast. The TTL is what stops a crashed desktop from muting a phone forever.
- **Wording is not written here.** `push/text.rs` renders the templates in
  `agentStatus.notificationText`; it is a deliberate twin of
  `apps/pragma/src/lib/agent-notification-text.ts`. Change the templates, not the code,
  and keep both renderers in step.
- **Expo answers per message.** A `DeviceNotRegistered` ticket drops that token from the
  registry; other errors are left alone (they are transient).

## Error responses

Non-streaming route failures must always answer with the JSON `ErrorBody`
(`{ code, message }`) at the error's HTTP status — `respond_json` in `http/mod.rs`
enforces this. Never let a handler error drop the `tiny_http` request: a dropped
request becomes an empty 500 the SDK cannot explain to the user. The brokered
"Pragma is not running" control reply maps to `409 conflict` so a phone can render
"Open Pragma on your computer".

## Rules

- No dependency on `pragma-core` or anything under `apps/pragma`.
- No business logic: validation here is limited to HTTP shape, auth, route matching,
  protocol method/event names, and protocol-version compatibility.
- Do not add TCP, auth, or gateway concerns directly to `pragma-server`.
- Keep the router hand-rolled and small; `tiny_http` is the only HTTP server layer.
