# packages/plugin — @pragma-sh/plugin

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
├── src/accounts.ts      # defineAccounts, ACCOUNT_PROVIDERS, legacy-usage adapter (resolveAccountProviders)
├── src/account-identity.ts # Canonical identity per well-known provider + credential-store readers
├── src/usage-limits.ts  # Usage-limit shapes + deprecated defineUsageLimitProvider
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
  `onInstall` / `onPragmaLoad` execution belongs to `@pragma-sh/plugins-host`.
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
  entirely.
- Do not bundle React into plugin builds. Author templates alias `react`, `react-dom`, and
  `react/jsx-runtime` to `@pragma-sh/plugin` subpaths.
- Add exported API with JSDoc and tests. Breaking API changes require a major version bump;
  additive changes require a minor bump.

## Accounts

`defineAccounts` is the account API; `usageLimits` / `defineUsageLimitProvider` are
deprecated. **Legacy adaptation happens host-side** through `resolveAccountProviders`, never
in `definePlugin`, so bundles already published against the old API still show up. Account
callbacks get an `AccountContext` whose `sdk.exec.run` already carries the login's env —
keep loaders free of env plumbing so one loader serves every account.

Accounts merge only when every harness derives the **same id** for a well-known provider.
`account-identity.ts` is that single derivation — `chatGptIdentity` (email, as Codex
reports), `anthropicOAuthIdentity` (`<org uuid>:<email>`, as `claude auth status` reports),
`gitHubIdentity` (lowercased login), `apiKeyIdentity` (SHA-256 digest, never the key) — plus
`identifyFromCredentialStore` for harnesses that keep several providers in one JSON file
(several entry keys, first wins; `apiKeyOnly` skips OAuth entries) and
`credentialStoreAccount`, which builds a whole provider from one store entry — following the
harness's sign-in, or with `switchable: true` swapping it (`credential-swap.ts`: the shared
file's entries are saved back to their owner, the bound login's written in, under the same
`<file>.lock` directory lock Pi's `proper-lockfile` takes; `<file>.pragma.json` records the
active login and the harness's own entries while displaced). Never re-derive an id in a plugin.
`sharedToken` (`AccountSharedToken`, `{ kind, read, write? }`) lets harnesses exchange a sign-in:
an OAuth one only between harnesses on the same OAuth client (kind named after the client), an
API key (`apiKeyTokenKind`) between any. The server links copies in a `tokenGroup` and syncs
OAuth copies to the newest token, because providers rotate refresh tokens; keys are never
synced. Never link two separate sign-ins, and never lend an `apiKeyOnly` provider's OAuth entry.
`credentialStoreAccount` shares each provider's key and makes it `switchable` by default.
Host-only helpers (`hostBuiltin`, `expandHome`, …) live in `host.ts`; nothing may touch a Node
built-in at import time, because this package also loads in the webview.

A plugin's `defineAccounts` list is its harnesses' supported providers — there is
deliberately no per-agent `providers` field duplicating it. `resolveAccountProviders` fills
each provider's `agentIds` (its `agent`, else every agent); every host reads them from there.
An optional `available(ctx)` asks the installed harness whether it still offers a provider;
the plugins sidecar drops one that answers false from the listing and keeps one that throws.

`ACCOUNT_PROVIDERS` is also the catalog of well-known API-key providers (OpenRouter, Google
Gemini API, DeepSeek, Groq, Z.ai, …) with a default `dashboardUrl` that `resolveAccountProviders`
fills in. **Only add a provider whose credential may be used outside its own first-party harness.** Claude Free/Pro/Max OAuth is restricted by Anthropic's terms to Claude Code and claude.ai, and Google suspends accounts that use Gemini CLI or Antigravity OAuth in other tools — so in any other harness, Anthropic and Google are API-key only (`apiKeyOnly: true`), and their OAuth sign-ins are never identified or presented as accounts. ChatGPT (Codex OAuth) and GitHub Copilot sign-ins are sanctioned in OpenCode and Pi. This package also runs in the webview and has no Node
types: file and home-dir access goes through `process.getBuiltinModule`, never a `node:`
import. None of these helpers refresh a token; rotating refresh tokens would sign the harness out.

## Commands

```bash
bun run --filter @pragma-sh/plugin generate
bun run --filter @pragma-sh/plugin typecheck
bun run --filter @pragma-sh/plugin test
bun run --filter @pragma-sh/plugin build
```
