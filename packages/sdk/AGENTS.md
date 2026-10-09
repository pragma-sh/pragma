# packages/sdk — @pragma-sh/sdk

Portable fetch-based TypeScript client for the local Pragma HTTP gateway
(`crates/pragma-gateway`). JS/TS consumers should use this instead of shelling out to
`pragma-cli` or hand-building HTTP requests.

## What it does

Exports one `PragmaClient` class with namespaces: `fs`, `git`, `exec`, `sessions`,
`agents`, `events`, `workspace`, `assets`, `push`, `theme`, `health`, `ports`, `scratchpads`,
`whiteboards`, and `accounts`. `client.rpc(method, payload)` is the low-level escape hatch for
not-yet-typed gateway RPCs. Bundled by Bunup as ESM, CJS, and `.d.ts`.
`client.createBoardDraft({ prompt, worktreeId, agentId, modelId?, reasoningId? })`
creates a draft card through the running desktop controller.

Configuration resolves from constructor options first, then `PRAGMA_GATEWAY_URL` and
`PRAGMA_GATEWAY_TOKEN`. The SDK must not read discovery files; only the gateway owns
`gateway.json` beside `daemon.sock`.

## When to use it

Use `@pragma-sh/sdk` in any JS/TS plugin or consumer that needs gateway access or agent
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
(`@pragma-sh/scratchpad-contract`), because that composition **is** the contract:
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

`client.health.check()` round-trips `GET /v1/health` (`status`, `protocolVersion`,
`gatewayVersion`). That route is unauthenticated, so it distinguishes an unreachable
host from a rejected token — which is what the mobile client's Settings heartbeat uses.

## Host-owned terminals, scripts, and accounts

These namespaces exist because the _host_ owns the thing, not the client:

- `client.tabs` — `openTerminal` / `close` / `listManaged`. A tab opened here
  belongs to the host: it survives the desktop republishing its own rows, it
  survives a server restart, and closing it ends the process everywhere. Opens
  take a caller-generated `requestId` and are idempotent under it.
- `client.scripts` — `list` / `run` / `stop` for `.pragma/scripts.json`. One run
  per script per worktree, decided by the host, so "already running" is the same
  answer on every device.
- `client.sessions` viewport methods — `info`, `acquireViewport`,
  `renewViewport`, `releaseViewport`, `resizeLeased`. A session's PTY grid is
  shared, so a small client _borrows_ it: renew while showing the terminal,
  release on the way out, and if the client vanishes the host expires the lease
  and restores the previous size. `attach` also takes `cursor`, which resumes
  from the last byte this renderer accepted instead of replaying everything.
- `client.accounts` — the host's account providers: `list` (providers, logins,
  bindings, live sessions), `usage` (limits loaded once per account), and
  `setBinding` to switch which account a harness launches with, globally or for
  one project. Sign-in runs in a hidden terminal on the host (`beginLogin` …
  `completeLogin`), so a phone can add an account without a desktop window.
- `client.ports` — `list(worktreeIds)` returns only listeners descended from those
  worktrees' live terminal shells; `forward({ projectId, port })` revalidates the exact
  listener, exposes an injected design proxy with the configured tunnel command, and
  returns its public browser URL.

## AI and GitHub

`client.ai` and `client.github` reach host-owned operations. Two rules shape them:

- **Committing is a job, not a call.** `commitAndDraftPullRequest` returns
  immediately; poll `getRun`. It is idempotent per `requestId` — reuse the id
  when retrying, because starting twice would commit the same work under two
  sets of messages. `cancelRun` stops the next step and never un-commits.
- **Publishing is separate from committing**, because a commit is local and a
  publish is not. `github.publish` pushes and creates, idempotent per
  `requestId`; `github.pullRequest` finds an existing one, including one opened
  outside Pragma, and reports merged separately from closed. `github.branches`
  lists what a pull request can merge into, with the repository default and the
  worktree's own head branch, so a client can offer a base without its own
  GitHub API code.

There is deliberately **no method that returns the GitHub token**: this
namespace is reachable from a paired phone. `ai.ask` is read-only by
construction; anything that should change files goes through `agents.launch`,
where the user sees and approves what it does.
`client.whiteboards` provides typed `create`, `get`, `list`, `search`, `edit`, `delete`,
and `view` calls over the host's `whiteboards` RPC. CRUD methods use the shared
`@pragma-sh/constants` whiteboard contract. `search` sends the same `list` action with a
required query, every id-based operation also requires `worktreeId`, and `view` decodes
the RPC's base64 `data` into PNG `Uint8Array` bytes; pass `dark: true` to use Excalidraw's
dark export palette.

## Fanouts

`client.fanouts` is full parity with `pragma-cli fanout` over the same `fanouts`
RPC: `create`, `get`, `read`, `send`, `retry`, `cancel`, `pick`, and a
`subscribe` snapshot-then-delta generator. Two shapes differ from the wire on
purpose:

- `read` decodes each target's base64 `data` into `raw: Uint8Array`; callers
  never see the wire encoding.
- `pick` takes no confirmation flag. Confirming is the UI's and the CLI's job;
  the SDK call is the destructive API itself, and a conflict or a partial
  cleanup resolves with a `stage` to resume from rather than throwing.

Domain failures survive the gateway: `PragmaGatewayError.details` carries the
host's `FanoutFailure` (its own code, the member, the finalize stage), so
callers branch on a code instead of parsing a message.

## Rules

- **`build` bundles `@pragma-sh/scratchpad-contract` normally.** It used to need
  `--external` to dodge a Windows crash (`panic: Expected pretty file path to
have only forward slashes`) when bunup walked that workspace-symlinked
  package's source. That was a Bun bug, not a bunup one — a plugin's catch-all
  `onResolve` deferring on a bare specifier that resolves into `node_modules`
  (oven-sh/bun#26798, fixed after 1.3.14) — and it is patched repo-wide in
  `patches/bunup@0.16.32.patch`, so `dist/` inlines the contract again and is
  self-contained. If that panic ever returns, fix it in the patch rather than
  marking more workspace dependencies external.
- Never hand-build gateway routes in a plugin — import from `@pragma-sh/sdk`.
- No `node:` imports in SDK source; keep it fetch/ReadableStream/TextDecoder based.
- `env.ts` is the only SDK file that touches process env, and it must use guarded
  `globalThis.process?.env` access.
- Streaming uses NDJSON over `fetch`/`ReadableStream`, not SSE or WebSockets.
- Future follow-up: `pragma-cli` could target the gateway later, but today it still
  talks directly to `pragma-server`.
- Follow-up not implemented without owner sign-off: Pragma terminal sessions do not yet
  inject `PRAGMA_GATEWAY_URL` / `PRAGMA_GATEWAY_TOKEN`.
