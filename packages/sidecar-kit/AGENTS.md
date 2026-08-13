# `@pragma/sidecar-kit` - Shared Sidecar Stdin Helpers

Tiny shared library for the Bun-compiled host sidecars (`pragma-ai`,
`pragma-automations`, `pragma-plugins`, ...). Holds cross-sidecar plumbing that
would otherwise be copy-pasted per package.

## Responsibilities

- `readStdinLines`: buffer `process.stdin` into trimmed, non-empty NDJSON lines and notify long-lived sidecars when their supervisor closes the pipe.

## Rules

- Keep this package dependency-free (no `@pragma/sdk`, no Node-only APIs beyond
  `process.stdin`) so any sidecar can depend on it without pulling in unrelated
  surface.
- Only add a helper here once it is duplicated verbatim across two or more
  sidecars — this package exists to be reused, not to pre-guess future sidecar
  needs.
- Long-lived sidecars must handle the stdin end callback, release owned
  listeners/timers when applicable, and exit. Stdin EOF is the cleanup signal
  that still arrives when `pragma-server` is killed abruptly.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
```
