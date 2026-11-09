# Pragma TypeScript SDK Reference

`@pragma-sh/sdk` provides typed, fetch-based access to local Pragma HTTP gateway. Use it from
JavaScript or TypeScript instead of shelling out or hand-building routes. Installed `.d.ts`
declarations remain authority for exact payloads.

## Client Configuration

```ts
import { PragmaClient } from "@pragma-sh/sdk";

const client = new PragmaClient();
```

Default config reads `PRAGMA_GATEWAY_URL` and `PRAGMA_GATEWAY_TOKEN`. Explicit config wins:

```ts
const client = new PragmaClient({
  baseUrl: "http://127.0.0.1:PORT",
  token: "gateway-token",
  fetch: globalThis.fetch,
  headers: { "x-pragma-device-id": "my-client" },
});
```

Both `baseUrl` and `token` are required. SDK does not read discovery files.

## Namespaces

| Namespace     | Main methods                                                            | Purpose                                |
| ------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| `fs`          | `listDir`, create/read/write/rename/delete                              | Worktree filesystem operations.        |
| `git`         | status/diff, stage/unstage, commit, sync, worktrees                     | Git and GitHub host operations.        |
| `exec`        | `run`                                                                   | Run host commands and collect results. |
| `sessions`    | `spawn`, `attach`, `write`, `resize`, `kill`, `rename`                  | PTY lifecycle and output.              |
| `agents`      | reporting, `catalog`, `launch`, `connect`, await methods                | Agent lifecycle and interaction.       |
| `events`      | `subscribe`                                                             | Generic snapshot/delta subscriptions.  |
| `workspace`   | `subscribe`                                                             | Typed workspace stream.                |
| `fanouts`     | `create`, `get`, `read`, `send`, `retry`, `cancel`, `pick`, `subscribe` | Parallel attempts.                     |
| `assets`      | `fetch`, `toDataUri`                                                    | Content-addressed assets.              |
| `scratchpads` | listing, comments, attachment, sending                                  | Managed scratchpad interaction.        |
| `whiteboards` | `create`, `get`, `list`, `search`, `edit`, `delete`, `view`             | Worktree-scoped Excalidraw scenes.     |
| `push`        | `register`, `unregister`, `list`, `test`, `presence`                    | Paired-device push.                    |
| `theme`       | `get`                                                                   | Merged host theme overrides.           |
| `health`      | `check`                                                                 | Gateway reachability and versions.     |

Use `client.rpc(method, payload)` only when no typed method exists.

## Agent Reporting

```ts
import {
  hasPragmaEnvironment,
  reportAttention,
  reportCleared,
  reportMessage,
  reportSessionId,
  reportSessionName,
  reportStarted,
  reportStopped,
} from "@pragma-sh/sdk";

if (hasPragmaEnvironment()) {
  await reportStarted({ agent: "my-agent" });
  await reportSessionName({ agent: "my-agent", name: "Refactor auth" });
  await reportSessionId({ agent: "my-agent", id: harnessSessionId });
}
```

Helpers resolve gateway, token, tab, and worktree from environment. They no-op outside full
Pragma environment. Catch reporting errors so reporting never breaks host agent.

| Helper              | Status      | Use                                                          |
| ------------------- | ----------- | ------------------------------------------------------------ |
| `reportStarted`     | `running`   | Work began.                                                  |
| `reportStopped`     | `done`      | Started work finished normally.                              |
| `reportAttention`   | `attention` | Answer or command decision needed.                           |
| `reportCleared`     | `cleared`   | Abort, reset, exit, or stale cleanup.                        |
| `reportSessionName` | unchanged   | Update display name only.                                    |
| `reportSessionId`   | unchanged   | Report the harness conversation id a later resume continues. |

`reportSessionId({ agent, id })` is status-less. Pragma stores `id` as the opaque
`harnessSessionId` on the agent's durable invocation record and never parses it; report it on
session create and every session switch so a crash or host restart resumes the conversation
that was actually active. Every normal report also carries the run id from
`PRAGMA_AGENT_RUN_ID` as `agentRunId` when a tracked launch set it. Status is runtime-only;
the session id is the durable recovery identity. See the plugin reference for the
`launch.resume` callback that rebuilds the resume argv.

## Duplex Agent Connection

```ts
const connection = await client.agents.connect({ agent, tabId, worktreeId });

for await (const event of connection) {
  // Events scoped to agent + tab.
}

await connection.send("Also update tests");
await connection.answer(requestId, "SQLite");
await connection.decide(requestId, true);
await connection.interrupt();
connection.close();
```

Optional `prompt` sends initial interjection. `interrupt` is transient and best-effort.

## Questions And Approvals

```ts
await reportAttention({
  agent: "my-agent",
  kind: "command",
  command: "rm generated.tmp",
  requestId,
});

const approved = await client.agents.awaitDecision({
  agent: "my-agent",
  requestId,
  timeoutMs: 300_000,
});
```

For questions, include `question`, optional `options`, and `requestId`, then call
`awaitAnswer`. Await methods return `null` on timeout, abort, dismissal where applicable,
or stream failure. Controlling clients use `reportDecision`, `reportAnswer`, `reportInput`,
and `reportInterrupt`.

## Sessions And Streaming

```ts
const { sessionId } = await client.sessions.spawn({
  cwd,
  worktreeId,
  cols: 120,
  rows: 40,
});

for await (const event of client.sessions.attach(sessionId, { signal })) {
  // Handle SessionEvent.
}

await client.sessions.write(sessionId, new TextEncoder().encode("bun test\n"));
await client.sessions.resize(sessionId, { cols: 120, rows: 40 });
```

Streams use NDJSON over `fetch` and `ReadableStream`, not SSE or WebSockets. Pass
`AbortSignal` for cancellation.

```ts
for await (const event of client.events.subscribe("workspace", { signal })) {
  if (event.type === "snapshot" || event.type === "delta") {
    // event.payload
  }
}
```

Use `client.workspace.subscribe()` for typed workspace payloads.

## Fanouts

```ts
const result = await client.fanouts.create({
  projectId,
  prompt: "Implement token refresh",
  parent: { kind: "existing", worktreeId },
  members: [{ selector: "pragma.opencode" }, { selector: "pragma.claude-code" }],
});

const output = await client.fanouts.read({ fanoutId: result.fanout.id, all: true });
```

`read` returns decoded `Uint8Array`. Partial creation resolves with healthy members plus
failures. `pick` is destructive: it merges winner, promotes scratchpads, then removes
attempt worktrees and branches. Caller owns confirmation.

## Scratchpads

```ts
const scratchpads = await client.scratchpads.getScratchpads({ root });
const comments = await client.scratchpads.getComments({ root, filePath });
await client.scratchpads.attachAgent({ root, filePath, tabId, agentId });
const result = await client.scratchpads.sendAttached({ root, filePath, worktreeId, text });
```

Do not parse managed frontmatter independently. Missing comments file means empty thread.
`sendAttached` returning `{ delivered: false }` is normal when no live agent is attached.

## Whiteboards

```ts
const board = await client.whiteboards.create({ worktreeId, title: "Architecture", scene });
const matches = await client.whiteboards.search({ worktreeId, query: "auth" });
const png = await client.whiteboards.view({ worktreeId, id: board.id, dark: true }); // Uint8Array
await client.whiteboards.edit({
  worktreeId,
  id: board.id,
  title: board.title,
  scene: nextScene,
  expectedVersion: board.version,
});
```

Scenes are lossless Excalidraw JSON. Preserve unknown element and app-state fields. Writes use
`expectedVersion`; re-read and reconcile instead of blindly overwriting a version conflict.
See `whiteboards.md` for the scene contract, a complete authoring example, and scratchpad embeds.

## Errors

```ts
import { PragmaGatewayError, PragmaTransportError } from "@pragma-sh/sdk";

try {
  await client.health.check();
} catch (error) {
  if (error instanceof PragmaGatewayError) {
    console.error(error.code, error.httpStatus, error.details);
  } else if (error instanceof PragmaTransportError) {
    console.error("Gateway unreachable or misconfigured", error.cause);
  }
}
```

- `PragmaGatewayError`: structured domain failure. Branch on `code`/`details`.
- `PragmaTransportError`: config, network, Fetch API, or non-JSON transport failure.

## Links

- Documentation: https://pragma-app.sh/docs
- Source: https://github.com/pragma-sh/pragma/tree/main/packages/sdk

## Local computer use

`client.computer` mirrors [`computer` CLI operations](computer-use.md), decodes screenshots to bytes, and owns durable task run/task/wait/resume/cancel helpers. It requires a separate `localToken` or `PRAGMA_LOCAL_GATEWAY_TOKEN`; never expose that credential through mobile pairing. Terminal calls retain tab attribution. Awaiting with an aborted signal stops waiting, not the host task; call `cancel` to stop future steps and `end` to release app leases. `PragmaComputerError` carries the host's domain code and recovery hint. Screen content stays untrusted data.
