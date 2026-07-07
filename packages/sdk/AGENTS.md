# packages/sdk — @pragma/sdk

Portable fetch-based TypeScript client for the local Pragma HTTP gateway
(`crates/pragma-gateway`). JS/TS consumers should use this instead of shelling out to
`pragma-cli` or hand-building HTTP requests.

## What it does

Exports one `PragmaClient` class with namespaces: `fs`, `git`, `exec`, `sessions`,
`agents`, and `events`. `client.rpc(method, payload)` is the low-level escape hatch for
not-yet-typed gateway RPCs. Bundled by Bunup as ESM, CJS, and `.d.ts`.

Configuration resolves from constructor options first, then `PRAGMA_GATEWAY_URL` and
`PRAGMA_GATEWAY_TOKEN`. The SDK must not read discovery files; only the gateway owns
`gateway.json` beside `daemon.sock`.

## When to use it

Use `@pragma/sdk` in any JS/TS plugin or consumer that needs gateway access or agent
status reporting. The top-level `reportStarted` / `reportStopped` / `reportAttention` /
`reportCleared` helpers return `Promise<void>` and no-op unless
`hasPragmaEnvironment()` sees gateway URL/token plus tab/worktree env.

For command-approval: `reportAttention({ kind: "command", command, requestId })` carries
the command + a correlation id to the approval toast; `client.agents.reportDecision(...)`
publishes the approve/deny verdict; and `awaitAgentDecision({ agent, requestId })` (or
`client.agents.awaitDecision(...)`) blocks on the agent event stream until the matching
`AgentDecision` arrives (resolving `null` on timeout/no-env). These are the JS side of the
same round-trip the Claude/Cursor blocking hooks drive via `pragma-cli agent
await-decision`.

For questions: `reportAttention({ kind: "question", question, requestId })` carries the
question; `client.agents.reportAnswer(...)` publishes the reply (or a `dismissed`
dismissal); and `awaitAgentAnswer({ agent, requestId })` (or `client.agents.awaitAnswer(...)`)
blocks until the matching `AgentAnswer` arrives, resolving the reply text — or `null` on
dismiss/timeout/no-env. This mirrors the decision round-trip (`pragma-cli agent
await-answer` / `answer`).

For a **single duplex channel to one running agent**, `client.agents.connect({ agent,
tabId, worktreeId, prompt? })` returns an `AgentConnection`: async-iterate it to read every
event routed to that agent + tab (`AgentStreamEvent` filtered to the target), and call its
methods to talk back on the same channel — `send(text)` interjects (publishes an
`AgentInput`, delivered via a harness input hook or a plugin watcher's `sendKeys`),
`answer(requestId, reply|null)` replies to a question, `decide(requestId, approved)` approves
/denies a command. `prompt` is **optional** — omit it to attach to an existing session
without sending anything. `connect` supersedes the old read-only `subscribe()`; the standalone
interjection publish is `client.agents.reportInput(...)` (or `pragma-cli agent input`).

## Rules

- Never hand-build gateway routes in a plugin — import from `@pragma/sdk`.
- No `node:` imports in SDK source; keep it fetch/ReadableStream/TextDecoder based.
- `env.ts` is the only SDK file that touches process env, and it must use guarded
  `globalThis.process?.env` access.
- Streaming uses NDJSON over `fetch`/`ReadableStream`, not SSE or WebSockets.
- Future follow-up: `pragma-cli` could target the gateway later, but today it still
  talks directly to `pragma-server`.
- Follow-up not implemented without owner sign-off: Pragma terminal sessions do not yet
  inject `PRAGMA_GATEWAY_URL` / `PRAGMA_GATEWAY_TOKEN`.
