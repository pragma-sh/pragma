# packages/constants — Shared Source of Truth

`@pragma/constants` is consumed by **both** the React frontend and the Rust backend.
It is the single authoritative location for any value that crosses the TS/Rust boundary.

## File map

```
packages/constants/
├── schema.json          # JSON Schema — the contract. EDIT THIS to change shape.
├── values.json          # The actual values. EDIT THIS to change values.
├── src/index.ts         # Typed TS export
├── src/lib.rs           # Rust export (typify-generated types + parsed values)
└── src/generated/       # Generated TS types (git-ignored; never edit directly)
```

## Workflow: adding or changing a shared value

1. Edit `schema.json` (the shape/contract).
2. Edit `values.json` (the value — must satisfy the schema).
3. Run `bun run generate` from the repo root (regenerates TS types; Rust regenerates on
   next `cargo build`).
4. Use it:
   - **TS:** `import { constants } from "@pragma/constants"` → `constants.app.name`
   - **Rust:** `pragma_constants::CONSTANTS.app.name`

The Rust side parses `values.json` against the schema-generated types at startup and
**panics loudly** if they ever drift apart — that's intentional.

## Key values

- `app.name` / `app.identifier` — mirror in `src-tauri/tauri.conf.json` (Tauri reads
  its config statically; keep the two in sync if you change window defaults here).
- `daemon.protocolVersion` — SemVer string mirrored from `crates/pragma-protocol`'s
  Cargo version by `bun run generate`. Exact equality on Hello / pairing / health.
  Do not edit it by hand.
- `updates.*` — shipped desktop auto-update defaults (production/dev check URLs,
  poll interval, apply-mode labels, installer platform ids). User overrides live in
  global `.pragma/config.json` `other` block (`OtherSettings`).
- `gateway.discoveryFile` / `gateway.tokenHeader` — local HTTP gateway discovery file
  name and bearer auth header. The gateway port is intentionally runtime-assigned and
  must not be added as a constant.
- `theme.fileName` / `theme.modes` — location and color-scheme blocks of the optional
  `.pragma/theme.json` color overrides (see `apps/pragma/AGENTS.md`). Only the file
  contract is shared; the token catalog is derived from `apps/pragma/src/index.css`.
- `protocol.*` — RPC method, event, and error names shared by Rust and TypeScript.
- `github.*` — OAuth client id, scopes, endpoint URLs.
- Keybindings schema — default key bindings registered in both TS (`useShortcuts`) and
  Rust (`keybindings::default_config`). `keybindings.configFileName` is the editable
  overrides file, resolved against the home directory (global) or the project root.
- `agentStatus.notificationText` — templates for agent alert wording (`{agent}`,
  `{project}`, `{worktree}`, `{tab}`), rendered by the desktop toast/banner
  (`apps/pragma/src/lib/agent-notification-text.ts`) and by the gateway's Expo push
  (`crates/pragma-gateway/src/push/text.rs`). `tabs.defaultTitles` is shared for the same
  reason: both languages must agree on when a tab is still unnamed.
- `gateway.push.*` — Expo push endpoint, batch size, accepted token prefixes, and how
  long a desktop focus heartbeat suppresses phone pushes.
- `agentStatus.*` — shipped defaults and limits for agent alerts: sounds directory,
  clip duration/byte caps, allowed extensions, and whether notifications are on. Users
  override them through the `agentStatus` block of a `.pragma/config.json`
  (`AgentStatusSettings`).
- `files.chunkBytes` / `files.maxBinaryBytes` — chunked binary reads. The host clamps a
  `ReadBytesRange` request to `chunkBytes` (keep it well under the 16 MB protocol frame:
  base64 adds a third) and the frontend refuses to assemble anything past
  `maxBinaryBytes` in the webview's heap.
- `scratchpads.*` — managed local MDX directory, extension, frontmatter key, and metadata
  version shared by CLI, Rust host, and desktop editor.
- `fanout.*` — the durable fanout state file, attempt branch prefix, the member
  floor (there is no ceiling), launch concurrency, follow-up delivery timeout, and the
  `PRAGMA_FANOUT_ID` / `PRAGMA_FANOUT_MEMBER_ID` environment variables every
  attempt session exports. The whole fanout wire contract (`Fanout`,
  `FanoutMember`, statuses, finalize stages, request/result types) lives in
  `schema.json` so the host, the CLI, the SDK, and the desktop share one shape.
- `brandIcon` entries — when you add one to `values.json`, add the icon body to
  `apps/pragma/src/lib/brand-icons.json` too (the app never fetches icons over the
  network).

## Rules

- **Never copy a value by hand across the boundary.** If it's needed in both TS and
  Rust, it belongs here.
- **Unreferenced schema definitions still generate TS types** (`bun run generate` uses
  `json-schema-to-typescript` with `--unreachable-definitions`). Define types here even
  if currently only one side uses them — the other side will eventually need them.
- **Re-export new Rust types explicitly.** `typify` generates every definition, but Rust
  consumers only see what `src/lib.rs` lists in its `pub use generated::{…}` block; add
  your type there or the crate won't compile against it.
- The Rust types are generated by `typify` during `cargo build` (build script in
  `src/`). If you change the schema, the Rust types update automatically on next build.
