# `@pragma/github-helpers` - GitHub Sidecar

Host-side GitHub helper package compiled to the `pragma-github` Bun sidecar.

## Responsibilities

- Own Octokit-based GitHub operations once GitHub moves behind `pragma-server`.
- Keep GitHub credentials on the host machine.
- Communicate with Rust over a small JSON/NDJSON command surface.

## Rules

- This package must not run in the frontend.
- Server code spawns the compiled `pragma-github` sidecar and proxies GitHub RPC.
- Keep the Rust/server command shape in sync whenever `src/cli.ts` changes.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
bun run build:sidecar
```
