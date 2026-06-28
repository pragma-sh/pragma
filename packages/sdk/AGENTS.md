# packages/sdk — @pragma/sdk

Typed Node/Bun wrapper around the `pragma-cli` CLI. JS/TS consumers should use this
instead of hand-building `pragma-cli` argv.

## What it does

Shells out to the `pragma-cli` binary (installed to `~/.local/bin` by the app on
startup) with typed options. When `executable` is not passed, the SDK uses
`PRAGMA_CLI` from the merged environment before falling back to `pragma-cli`. Bundled by
Bunup as ESM, CJS, and `.d.ts`.

## When to use it

Use `@pragma/sdk` in any JS/TS plugin or consumer that needs to report agent status
(started / stopped / attention / cleared). See `packages/opencode-plugin` for a
real-world example.

## Rules

- Never hand-build `pragma-cli` argv in a plugin — import from `@pragma/sdk`.
- The SDK guards on the Pragma env vars (`PRAGMA_DAEMON_SOCKET`, etc.) before shelling
  out; it is a no-op outside a Pragma terminal session.
- See `crates/pragma-cli/AGENTS.md` for the underlying CLI contract.
