# packages/dev-test-plugin — @pragma/dev-test-plugin

Lightweight dev/test Pragma plugin. Exercises the public `@pragma/plugin`
surface (sidebar tabs, a sidebar card, a plugin web view, host + SDK event hooks) and ships with
Vitest + jsdom coverage for those React hooks. It also served as the
real-world test target for the `create-pragma-plugin` scaffolder CLI: it was
generated non-interactively with

```bash
bun packages/create-pragma-plugin/dist/cli.js packages/dev-test-plugin \
  --name @pragma/dev-test-plugin --pm bun --capabilities ui,commands,agents --force
```

and then adapted in place (workspace deps, split modules, tests, AGENTS.md).

## What it contributes

- **`OverviewTab`** (`src/overview-tab.tsx`) — primary sidebar tab; shows the
  active project and the host `Button` / `Kbd` UI primitives.
- **`FortuneTab`** (`src/fortune-tab.tsx`) — **random secondary sidebar tab**.
  Picks a dev fortune from `FORTUNES` (`src/fortunes.ts`, injectable `rng` for
  deterministic tests), rerolls on a button click or `mod+k`, and persists the
  last index with `useStoredState`. Uses `useProject` and `useNotify`.
- **`AgentPulseCard`** (`src/agent-pulse-card.tsx`) — **sidebar card** that
  **hooks an SDK event**: uses `useSdk()` to subscribe to the gateway
  `agentStatus` event stream (`sdk.events.subscribe("agentStatus", …)`) and
  renders the latest reported agent/status; uses `useEvent("agent.report")`
  to count host-forwarded agent reports. Uses `useProject`.
- **`reportWebView`** (`src/report-webview.tsx`) — **workspace web view tab**
  declared with `defineWebView`; `openReportWebView()` opens it with a typed
  payload and `dedupeKey`, and the view reads that payload via
  `useWebViewPayload`.
- One `defineCommand` greeting (`pragma-dev-test-plugin.hello`).
- One `defineCommand` web view opener (`pragma-dev-test-plugin.report.open`).

`src/index.tsx` is the single `definePlugin` entry the host loadser as the
ESM bundle (`dist/index.js`, built by Vite with React externalized to the
`@pragma/plugin` shims via `vite.config.ts` aliases).

## Testing the React hooks

Tests run under jsdom (`vitest.config.ts`) against the real React from
`node_modules`; the `@pragma/plugin` hooks and UI still delegate to a
mocked `globalThis.__PRAGMA__` bridge installed by `src/test/setup.ts` +
`src/test/bridge.ts` (`createBridge(overrides)` builds the bridge and
returns an `emit(name, payload)` for `useEvent`; `eventsFrom(...)` builds an
SDK event async generator). Cover:

- `src/fortunes.test.ts` — pure pick, deterministic with injected rng.
- `src/overview-tab.test.tsx` — `useProject` + host `Button`/`Kbd`.
- `src/fortune-tab.test.tsx` — `useStoredState`, `useNotify`, reroll shortcut + notify.
- `src/agent-pulse-card.test.tsx` — `useSdk` SDK event stream updates the
  pulse; `useEvent("agent.report")` increments the counter via `emit`.
- `src/report-webview.test.tsx` — `openReportWebView()` delegates to the
  host bridge action with the `defineWebView` handle and dedupe metadata.

## Rules

- Stay a **pure TypeScript Pragma plugin**: import only `@pragma/plugin`,
  `@pragma/plugin/ui`, and `@pragma/sdk`. Do not import host app internals.
- **Never bundle React.** `vite.config.ts` aliases `react`,
  `react-dom`, and `react/jsx-runtime` to the `@pragma/plugin` shims; tests
  instead resolve the real React and set `jsxImportSource: "react"` in
  `tsconfig.json` so intrinsic elements type-check (the `@pragma/plugin`
  jsx-runtime shim intentionally re-exports `jsx`/`jsxs`/`Fragment` but not a
  JSX namespace; the vite alias still externalizes JSX to the shim at build
  time).
- Keep `src/test/bridge.ts` as the single place that fabricates the
  `__PRAGMA__` bridge for tests; add host hooks there as new plugin hooks are
  exercised.
- Add a test with every behavior change. Run `bun --bun vitest run`.

## Commands

```bash
bun run --filter @pragma/dev-test-plugin build
bun run --filter @pragma/dev-test-plugin typecheck
bun run --filter @pragma/dev-test-plugin test
bun run --filter @pragma/dev-test-plugin lint
```

## Adding functionality

To add another contribution, extend `src/index.tsx`'s `definePlugin` object
(`ui.sidebarTabs`, `ui.sidebarCards`, `commands`, …), keep one component per
file, render through the bridge hooks (not app internals), and add a
`*.test.tsx` that fabricates the needed bridge via `createBridge`. For a new
SDK-backed hook, add a matching generator helper in `src/test/bridge.ts`
(see `eventsFrom`).
