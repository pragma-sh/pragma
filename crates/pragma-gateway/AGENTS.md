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
- Persist the bearer token in a `gateway-token` file (mode `0600`) beside `daemon.sock`
  when `--token` is absent: read it if present, otherwise generate and write it. This
  keeps the token stable across gateway restarts so paired remote devices are not
  disconnected on every respawn. The desktop `regenerate_gateway_token` command deletes
  this file (and kills the gateway) to force a fresh token. `--token` still overrides.
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
