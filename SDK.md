# `@pragma/sdk` — the preferred plugin route

Portable fetch-based TypeScript client for the local Pragma HTTP gateway. Use this in
JS/TS plugins or consumers that need to report agent status or call Pragma host APIs.

Source: `packages/sdk/` (`@pragma/sdk`). Real-world consumer:
`packages/opencode-plugin/`. See [CREATE_PLUGIN.md](./CREATE_PLUGIN.md) for the full
plugin workflow.

## What it does

Exports one `PragmaClient` class with namespaced clients:

```ts
const client = new PragmaClient({ baseUrl, token });

await client.fs.pathExists({ root: "/repo", path: "README.md" });
await client.git.isDirty({ root: "/repo" });
await client.exec.run({ cwd: "/repo", commands: ["bun test"] });
```

The SDK resolves gateway access from constructor config or `PRAGMA_GATEWAY_URL` /
`PRAGMA_GATEWAY_TOKEN`. It does not read discovery files.

## Agent Reporting

Top-level helpers return `Promise<void>` and no-op unless `hasPragmaEnvironment()` sees
gateway URL/token plus `PRAGMA_TAB_ID` and `PRAGMA_WORKTREE_ID`.

```ts
import { reportAttention, reportCleared, reportStarted, reportStopped } from "@pragma/sdk";

await reportStarted({ agent: "opencode" });
await reportStopped({ agent: "opencode" });
await reportAttention({ agent: "opencode", kind: "question" });
await reportCleared({ agent: "opencode" });
```

## Fanouts

`client.fanouts` mirrors `pragma-cli fanout` over the same host RPC:

```ts
const { fanout, partial, failures } = await client.fanouts.create({
  projectId,
  parent: { kind: "existing", worktreeId: parentWorktreeId },
  prompt: "Implement token refresh and tests",
  defaultReasoningId: "high",
  members: [{ selector: "pragma.opencode" }, { selector: "pragma.claude-code" }],
});

const output = await client.fanouts.read({ fanoutId: fanout.id, all: true, lines: 200 });
output.targets[0].raw; // Uint8Array — base64 never reaches callers

await client.fanouts.send({
  fanoutId: fanout.id,
  target: { kind: "all" },
  message: "Also include migration docs",
});

for await (const event of client.fanouts.subscribe({ fanoutId: fanout.id })) {
  // "snapshot" first, then full-replacement "delta"s
}

// Destructive: merges the winner into the parent and deletes every attempt.
await client.fanouts.pick({ fanoutId: fanout.id, memberId });
```

Every method takes `{ signal }`, and `get`/`read`/mutations accept either a
`fanoutId` or any `worktreeId` that belongs to the fanout. Domain failures
arrive as `PragmaGatewayError` with the host's `FanoutFailure` in `.details`.

## Rules

- Never shell out or hand-build gateway routes in a plugin; import from `@pragma/sdk`.
- Keep reporting best-effort: catch/log in debug mode so reporting cannot disrupt the
  host tool.
- Streaming APIs use NDJSON over `fetch` and `ReadableStream`.
