---
name: code-quality
description: Use when running or fixing lint/format/typecheck for Pragma, or before committing/pushing — covers oxlint, oxfmt, clippy, rustfmt, Vitest, cargo test, conventional commits, and the husky hooks.
---

# Code quality & conventions

Formatting and linting are automated and enforced. CI checks (never fixes); husky
auto-fixes on commit. Treat warnings as errors in both languages.

## Commands (run from repo root)

```bash
bun run check          # Everything CI checks, in one shot
bun run lint           # oxlint (TS)        -> fix: bun run lint:fix
bun run format         # oxfmt --write (TS) -> verify: bun run format:check
bun run typecheck      # turbo: generate constants then tsc across packages
bun run test           # turbo: Vitest across packages
bun run rust:fmt       # cargo fmt --all    -> verify: bun run rust:fmt:check
bun run rust:clippy    # cargo clippy -D warnings
bun run rust:test      # cargo test --workspace
```

## Standards (mirrored across TS & Rust)

- TS: `strict` + `noUncheckedIndexedAccess` + no unused. Rust: clippy `all` +
  `pedantic` as `-D warnings`, `unsafe_code = "forbid"`.
- Don't silence a lint without a one-line comment explaining why.
- Naming: TS `camelCase`/`PascalCase`; Rust `snake_case`/`PascalCase`. Wire JSON is
  `camelCase`.
- Errors: TS narrow with `instanceof`; Rust return `Result` + `?`. `panic!`/`expect`
  only for unrecoverable startup invariants.
- Document exported/public items (JSDoc line / `///`).

## Commits (Conventional Commits)

`<type>(<scope>): <subject>` — types: feat, fix, docs, style, refactor, perf, test,
build, ci, chore, revert. Scope = package/app name (`pragma`, `constants`, `ci`).

## Hooks

- pre-commit → lint-staged auto-fixes staged files.
- commit-msg → commitlint.
- pre-push → typecheck + cargo fmt check + cargo check.

If a hook blocks you, fix the underlying issue — don't bypass with `--no-verify`.
