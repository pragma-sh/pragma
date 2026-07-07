# `@pragma/automations` - Automation Runtime

Author-facing automation API plus the `pragma-automations` Bun sidecar.

## Responsibilities

- Export `defineAutomation` and public automation author types.
- Run as a long-lived host sidecar owned by `pragma-server`.
- Load single-file `.ts`/`.js` automations, install bare imports into a managed cache, run event listeners, and execute bodies on server request.

## Rules

- Keep the NDJSON command/event contract in `src/cli.ts` in sync with `crates/pragma-server/src/automations.rs`.
- Automations are arbitrary host code. Do not weaken local approval semantics when changing load behavior.
- The sidecar may execute automation code only after the server has decided it is trusted/approved.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
bun run build:sidecar
```
