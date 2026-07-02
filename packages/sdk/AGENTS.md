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
