# packages/plugins-host — @pragma/plugins-host

Bun-compiled `pragma-plugins` host sidecar: resolves the agent catalog from plugin
contributions and serves icon assets to `pragma-server`. Mirrors the `pragma-automations`
sidecar pattern ( supervised child, NDJSON stdin/stdout, lazy respawn-on-send, cached
last publish so a crash never blanks the catalog).

## What it does

Spawns under `pragma-server` (`crates/pragma-server/src/plugins_host.rs`), reads NDJSON
commands on stdin, and emits NDJSON events on stdout:

- **Commands** (stdin): `load` (roots + gatewayUrl + gatewayToken). There is no separate
  `reload` command — the host re-sends a full `load` with freshly read gateway
  credentials whenever the catalog must be re-resolved.
- **Events** (stdout): `ready`, `catalog` (the `AgentCatalog` + the hash → asset map),
  `error`, `log`.

On `load` it resolves plugin manifests in TypeScript: global `~/.pragma/config.json` plus
each project root's `.pragma/config.json` (`manifest.ts`, mirroring the Rust
`plugins.rs` `resolve_local_dir` semantics — accepted duplication, flagged as debt until
resolution moves into `pragma-core`). It imports the built-in agent plugins
(`@pragma/{claude-code,opencode,cursor}-plugin/pragma-agent`) and any local-path plugins
via Bun `import()` (the `pragma-watch` precedent), resolves async model providers through a
`PragmaClient` pointed at the local gateway, hashes icon files (`sha256`, 256 KB cap), and
assembles the `AgentCatalog`.

## File map

```
packages/plugins-host/
├── src/
│   ├── cli.ts        # Sidecar entry: stdin loop, resolves + assembles catalog, emits events
│   ├── catalog.ts    # assembleCatalog, resolveModels, hashIcon, mimeForIcon, ICON_MAX_BYTES
│   ├── manifest.ts   # resolveManifests: global + project .pragma/config.json plugins
│   ├── index.ts      # Re-exports for tests/consumers
│   ├── catalog.test.ts
│   └── manifest.test.ts
└── package.json      # bin: pragma-plugins -> src/cli.ts; build:sidecar compiles dist/pragma-plugins
```

## Built-in agents live in the plugin packages

The three built-in agent definitions (`claude-code`, `opencode`, `cursor`) live in their
plugin packages' `src/pragma-agent.ts` and are imported here directly. This is the one
source of truth the catalog sidecar and the in-webview `apps/pragma/src/plugins/builtin-agents.ts`
share — the webview path re-exports them (overriding `iconPath` with a browser URL and
attaching the built-in watchers). Do not duplicate agent metadata across packages.

## Catalog wire types

`AgentModelEntry` / `AgentReasoning` / `CatalogAgent` / `AgentCatalog` / `AgentIcon` are
promoted into `@pragma/constants` (`schema.json`) so the wire type has one source of
truth, shared with `@pragma/sdk`'s `AgentsClient.catalog()` and `AssetsClient`. Catalog
agents include resolved launch commands for each model/reasoning selection plus terminal
input timing, allowing `pragma-server` to launch agents without desktop webview.

## Assets

Icons are hashed (`sha256`, 256 KB cap) and reported as `{ hash, mime, path }`. The
gateway serves them at `GET /v1/assets/{hash}` (raw bytes, `ETag` = hash,
`Cache-Control: public, max-age=31536000, immutable`). The hash is validated as lowercase
hex sha256 and only ever used as a map key — never a path — so there is no traversal
surface. The SDK fetches assets through the authenticated transport (`AssetsClient`), not
bare `<img>` URLs, so the bearer token rides the header.

## Staging

`build:sidecar` (`bun build src/cli.ts --compile --outfile dist/pragma-plugins`) is run by
`apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh`, which copies it to
`binaries/pragma-plugins-$triple`. `tauri.conf.json` lists it under `externalBin`.
