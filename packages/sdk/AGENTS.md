# packages/sdk — @pragma/sdk

Portable fetch-based TypeScript client for the local Pragma HTTP gateway
(`crates/pragma-gateway`). JS/TS consumers should use this instead of shelling out to
`pragma-cli` or hand-building HTTP requests.

## What it does

Exports one `PragmaClient` class with namespaces: `fs`, `git`, `exec`, `sessions`,
`agents`, `events`, `workspace`, `assets`, `push`, `theme`, and `scratchpads`. `client.rpc(method, payload)` is the low-level escape hatch for
not-yet-typed gateway RPCs. Bundled by Bunup as ESM, CJS, and `.d.ts`.

Configuration resolves from constructor options first, then `PRAGMA_GATEWAY_URL` and
`PRAGMA_GATEWAY_TOKEN`. The SDK must not read discovery files; only the gateway owns
`gateway.json` beside `daemon.sock`.

## When to use it

Use `@pragma/sdk` in any JS/TS plugin or consumer that needs gateway access or agent
status reporting. The top-level `reportStarted` / `reportStopped` / `reportAttention` /
`reportCleared` / `reportSessionName` helpers return `Promise<void>` and no-op unless
`hasPragmaEnvironment()` sees gateway URL/token plus tab/worktree env.
`reportSessionName({ agent, env, name })` is status-less: it renames the hosting tab
to the session's display name (manual tab renames win); call it on session create,
rename, and switch.

For command-approval: `reportAttention({ kind: "command", command, requestId })` carries
the command + a correlation id to the approval toast; `client.agents.reportDecision(...)`
publishes the approve/deny verdict; and `awaitAgentDecision({ agent, requestId })` (or
`client.agents.awaitDecision(...)`) blocks on the agent event stream until the matching
`AgentDecision` arrives (resolving `null` on timeout/no-env). These are the JS side of the
same round-trip the Claude/Cursor blocking hooks drive via `pragma-cli agent
await-decision`.

For questions: `reportAttention({ kind: "question", question, options?, requestId })`
carries the question text and optional answer choices (`{ label, description? }`); `client.agents.reportAnswer(...)`
publishes the reply (or a `dismissed` dismissal); and `awaitAgentAnswer({ agent, requestId })`
(or `client.agents.awaitAnswer(...)`) blocks until the matching `AgentAnswer` arrives,
resolving the reply text — or `null` on dismiss/timeout/no-env. This mirrors the decision
round-trip (`pragma-cli agent await-answer` / `answer`).

For a **single duplex channel to one running agent**, `client.agents.connect({ agent,
tabId, worktreeId, prompt? })` returns an `AgentConnection`: async-iterate it to read every
event routed to that agent + tab (`AgentStreamEvent` filtered to the target), and call its
methods to talk back on the same channel — `send(text)` interjects (publishes an
`AgentInput`, delivered via a harness input hook or a plugin watcher's `sendKeys`),
`answer(requestId, reply|null)` replies to a question, `decide(requestId, approved)` approves
/denies a command, and `interrupt(requestId?)` publishes a transient `AgentInterrupt` — a
watcher subscribed to the tab sends ESC into the agent's PTY (no replay buffer; best-effort
to live watchers). `prompt` is **optional** — omit it to attach to an existing session
without sending anything. `connect` supersedes the old read-only `subscribe()`; the standalone
publishes are `client.agents.reportInput(...)` / `client.agents.reportInterrupt(...)` (or
`pragma-cli agent input`).

`client.scratchpads` is the whole scratchpad surface, not just the list route.
`getScratchpads({ root })` is the gateway call; the rest compose the filesystem
and agent namespaces over the shared file contract
(`@pragma/scratchpad-contract`), because that composition **is** the contract:
`getComments` / `comment` / `setComments` read and write the sibling
`<file>.mdx.comments.json` (a missing file is an empty thread, not an error),
`attachAgent({ tabId, agentId })` records the attachment in managed frontmatter,
and `sendAttached({ worktreeId, text })` re-reads that frontmatter on the host
and interjects to the attached tab. `sendAttached` resolves
`{ delivered: false }` when nothing is attached — the common case, since a
scratchpad outlives the session that wrote it — so callers raise their own
"attach an agent" UI instead of catching. It addresses the agent by
`runtimeAgentId(...)` (the catalog id's last segment): the qualified id is
invisible on the agent event stream.

`client.push` covers Expo push for a paired phone: `register({ token })` /
`unregister()` manage this installation's token (the gateway keys them by the
`x-pragma-device-id` header the client already sends), `list()` reports registered
phones, `test()` fires a check notification, and `presence({ focused })` is the
desktop's focus heartbeat that suppresses phone pushes while the window is in front.
Delivery itself is the gateway's job — nothing here talks to Expo.

`client.scratchpads.getScratchpads({ root })` lists a worktree's managed
scratchpads (`ScratchpadFile[]`): id, title, worktree-relative path, the full MDX
source, and the agent tab the scratchpad is attached to. The host does the
listing and frontmatter parsing (`pragma_core::scratchpads`, behind
`GET /v1/scratchpads`), so a phone reads exactly what the desktop sidebar does —
never re-implement that parse in a client.

`client.theme.get({ root? })` returns the user's merged `.pragma/theme.json` color
overrides (`HostTheme`: `colors[mode][token]` plus `sources`). Pass an absolute `root`
to layer that project's file over the global one; omit it for the global theme alone.
Only overrides are returned — a client keeps its own shipped defaults for every token
the user has not themed.

## Rules

- **`build` marks `@pragma/scratchpad-contract` `--external`.** Letting bunup
  bundle/dts-inline it crashes on Windows (`panic: Expected pretty file path
to have only forward slashes` — a long-standing unfixed upstream bug,
  oven-sh/bun#14843, #14972, #15007, #15421) when it walks that
  workspace-symlinked package's source during `--dts` generation. Marking it
  external stops bunup from ever opening those files: the emitted
  `dist/index.d.ts` just re-exports its types (`export * from
"@pragma/scratchpad-contract"`), and `dist/index.js` keeps a plain import
  instead of inlining it — resolved at runtime the same way any other
  workspace package is. If `bun run build` starts panicking again with that
  message, suspect a _new_ raw-src workspace dependency needing the same
  `--external` treatment before reaching for anything more invasive.
- Never hand-build gateway routes in a plugin — import from `@pragma/sdk`.
- No `node:` imports in SDK source; keep it fetch/ReadableStream/TextDecoder based.
- `env.ts` is the only SDK file that touches process env, and it must use guarded
  `globalThis.process?.env` access.
- Streaming uses NDJSON over `fetch`/`ReadableStream`, not SSE or WebSockets.
- Future follow-up: `pragma-cli` could target the gateway later, but today it still
  talks directly to `pragma-server`.
- Follow-up not implemented without owner sign-off: Pragma terminal sessions do not yet
  inject `PRAGMA_GATEWAY_URL` / `PRAGMA_GATEWAY_TOKEN`.
