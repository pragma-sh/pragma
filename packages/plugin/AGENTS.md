# packages/plugin — @pragma/plugin

Public TypeScript API for authoring Pragma plugins. This package is a compile-time stub:
runtime imports delegate to `globalThis.__PRAGMA__`, which the Pragma host installs before
loading any plugin bundle.

## File map

```
packages/plugin/
├── src/index.ts         # Public exports
├── src/plugin.ts        # definePlugin + API-version stamp
├── src/agent.ts         # defineAgent and agent types
├── src/contributions.ts # UI slot, web view, and command contribution helpers
├── src/hooks.ts         # Hook delegates onto __PRAGMA__.hooks
├── src/bridge.ts        # __PRAGMA__ bridge/action contract
├── src/react*.ts        # React/ReactDOM/jsx-runtime shims
├── src/ui.ts            # Host UI primitive delegates
└── scripts/generate-version.ts
```

## Rules

- Keep this package browser-safe and side-effect-light. It must not import app internals.
- `definePlugin` is the only place the baked `PLUGIN_API_VERSION` is stamped.
- Runtime shims must fail loudly when `globalThis.__PRAGMA__` is absent.
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
