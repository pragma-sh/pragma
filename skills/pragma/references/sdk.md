# Pragma TypeScript SDK Reference

`@pragma/sdk` provides typed, fetch-based access to local Pragma HTTP gateway. Use it from
JavaScript or TypeScript instead of shelling out or hand-building routes. Installed `.d.ts`
declarations remain authority for exact payloads.

## Client Configuration

```ts
import { PragmaClient } from "@pragma/sdk";

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
  reportSessionName,
  reportStarted,
  reportStopped,
} from "@pragma/sdk";

if (hasPragmaEnvironment()) {
  await reportStarted({ agent: "my-agent" });
  await reportSessionName({ agent: "my-agent", name: "Refactor auth" });
}
```

Helpers resolve gateway, token, tab, and worktree from environment. They no-op outside full
Pragma environment. Catch reporting errors so reporting never breaks host agent.

| Helper              | Status      | Use                                   |
| ------------------- | ----------- | ------------------------------------- |
| `reportStarted`     | `running`   | Work began.                           |
| `reportStopped`     | `done`      | Started work finished normally.       |
| `reportAttention`   | `attention` | Answer or command decision needed.    |
| `reportCleared`     | `cleared`   | Abort, reset, exit, or stale cleanup. |
| `reportSessionName` | unchanged   | Update display name only.             |

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

## Errors

```ts
import { PragmaGatewayError, PragmaTransportError } from "@pragma/sdk";

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
