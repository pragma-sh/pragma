# `@pragma/sidecar-kit` - Shared Sidecar Stdin Helpers

Tiny shared library for the Bun-compiled host sidecars (`pragma-ai`,
`pragma-automations`, `pragma-plugins`, ...). Holds cross-sidecar plumbing that
would otherwise be copy-pasted per package.

## Responsibilities

- `readStdinLines`: buffer `process.stdin` into trimmed, non-empty NDJSON lines.

## Rules

- Keep this package dependency-free (no `@pragma/sdk`, no Node-only APIs beyond
  `process.stdin`) so any sidecar can depend on it without pulling in unrelated
  surface.
- Only add a helper here once it is duplicated verbatim across two or more
  sidecars — this package exists to be reused, not to pre-guess future sidecar
  needs.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
```
