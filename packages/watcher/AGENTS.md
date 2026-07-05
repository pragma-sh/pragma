# `@pragma/watcher` - Watcher Sidecar

Host-side Bun sidecar compiled as `pragma-watch`. It loads plugin `defineWatcher`
contributions, attaches them to live PTY sessions through `@pragma/sdk`, streams output,
and writes watcher-originated key bytes back through the gateway.

## Rules

- This package runs on the host, never in the frontend webview.
- Keep transport through `@pragma/sdk`; do not hand-build HTTP routes.
- Every `sendKeys` call must write an audit line to stderr with plugin, agent, and session ids.
- Watchers attach only to the plugin/agent pair the app passes in.

## Commands

```sh
bun run typecheck
bun run build:sidecar
```
