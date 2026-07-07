# `@pragma/watcher` - Watcher Sidecar

Host-side Bun sidecar compiled as `pragma-watch`. It loads plugin `defineWatcher`
contributions, attaches them to live PTY sessions through `@pragma/sdk`, streams output,
and writes watcher-originated key bytes back through the gateway. The `WatcherContext` a
watcher receives carries `agentId` (the full plugin-qualified agent id) so a watcher can
`sdk.agents.connect({ agent: agentId, ... })` to read the control channel (verdicts,
interjections) scoped to its own agent + tab.

## Rules

- This package runs on the host, never in the frontend webview.
- Keep transport through `@pragma/sdk`; do not hand-build HTTP routes.
- Every `sendKeys` call must write an audit line to stderr with plugin, agent, and session ids.
- Watchers attach only to the plugin/agent pair the app passes in.
- Session attach can race ahead of foreground PTY spawn; retry initial `notFound` before giving up.

## Commands

```sh
bun run typecheck
bun run build:sidecar
```
