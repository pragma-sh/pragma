# packages/plugin — @pragma/plugin

Public TypeScript API for authoring Pragma plugins. This package is a compile-time stub:
runtime imports delegate to `globalThis.__PRAGMA__`, which the Pragma host installs before
loading any plugin bundle.

## File map

```
packages/plugin/
├── src/index.ts         # Public exports
├── src/catalog.ts       # Bridge-free agent/plugin declarations for host catalog sidecars
├── src/plugin.ts        # definePlugin + API-version stamp
├── src/agent.ts         # defineAgent and agent types
├── src/watcher.ts       # defineWatcher and watcher context types
├── src/contributions.ts # UI slot, Settings page, web view, and command contribution helpers
├── src/usage-limits.ts  # Host-rendered provider usage-limit declarations
├── src/theme.ts         # Selectable Theme-settings declarations
├── src/hooks.ts         # Hook delegates onto __PRAGMA__.hooks
├── src/storage.ts       # Plugin-scoped durable JSON-storage type
├── src/runtime.ts       # Imperative event, theme, and session access
├── src/bridge.ts        # __PRAGMA__ bridge/action contract
├── src/react*.ts        # React/ReactDOM/jsx-runtime shims
├── src/ui.ts            # Host UI primitive delegates
└── scripts/generate-version.ts
```

## Rules

- Keep this package browser-safe and side-effect-light. It must not import app internals.
- `definePlugin` is the only place the baked `PLUGIN_API_VERSION` is stamped. Server-side
  `onInstall` / `onPragmaLoad` execution belongs to `@pragma/plugins-host`.
- Runtime shims must fail loudly when `globalThis.__PRAGMA__` is absent.
- Storage reaches plugins only through a host-bound `PluginContext.storage`; never expose
  a bridge or helper that accepts a plugin ID from plugin code.
- **A plugin's `pragma.main` bundle must be browser-safe too.** The desktop webview
  imports it through a blob URL to list launchable agents, so a **static** `node:` import
  never resolves and a module-scope `process.*` read throws — either drops the plugin to
  `status: "failed"` and its agents vanish from the launcher, while the Bun sidecars keep
  loading the same bundle and reporting a healthy catalog. That split brain is what hid
  OpenCode from the launcher. Keep node-only work inside the function that needs it
  (`globalThis.process?.…`, `await import("node:…")`), or off the entry's import graph
  entirely. `stage-bundled-plugins.sh` fails the build on a static `node:` import in a
  bundled plugin's entry.
- Do not bundle React into plugin builds. Author templates alias `react`, `react-dom`, and
  `react/jsx-runtime` to `@pragma/plugin` subpaths.
- Add exported API with JSDoc and tests. Breaking API changes require a major version bump;
  additive changes require a minor bump.

## Commands

```bash
bun run --filter @pragma/plugin generate
bun run --filter @pragma/plugin typecheck
bun run --filter @pragma/plugin test
bun run --filter @pragma/plugin build
```
