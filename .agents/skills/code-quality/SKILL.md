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

Native menu regression: `cargo test -p pragma --test linux_window_menu` runs on
the OS main thread without starting Pragma servers or webviews. It is Unix-only (a
Tauri test binary on Windows aborts at load with `STATUS_ENTRYPOINT_NOT_FOUND`, since
`tauri-build` embeds the common-controls manifest only into the main exe). On headless
Linux, use `xvfb-run -a cargo test -p pragma --test linux_window_menu`; Linux CI wraps
the whole Rust suite in Xvfb so GTK coverage never silently skips.

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
- pre-push → typecheck + cargo fmt check + sidecar staging via
  `bun run --filter pragma sidecar:server` + cargo check + fallow audit.

If a hook blocks you, fix the underlying issue — don't bypass with `--no-verify`.

macOS CI cleans `v8`'s release artifacts after Rust cache restore with
`cargo clean --package v8 --release`: the cache can retain its build-script
fingerprint while pruning the native archive. Keep that recovery before the build.

Computer-use changes need host/fake-backend/pure-rule tests, SDK/System 1/decision fixture tests, and `bun run --filter @pragma-sh/ai-helpers computer:eval`. Windows CI checks x64 and ARM64. A macOS source cross-check cannot validate native linking or OS behavior: V8 has no Windows GNU bindings, and MSVC cross-builds need Windows system headers for SQLite. Record permission, fullscreen, mixed-DPI, stop-latency and signed-helper checks separately; synthetic replay is not live OS/model accuracy.

macOS overlay focus regression: `PRAGMA_NATIVE_FOCUS_TEST=1 cargo test -p pragma --test macos_background_webview` on an interactive desktop (needs WindowServer access outside the filesystem sandbox). It checks both construction and showing; normal test runs skip it. For SDK tests that assume a standalone script caller, unset inherited `PRAGMA_TAB_ID` and `PRAGMA_WORKTREE_ID` in the test command, since Pragma terminals deliberately attribute those calls to their agent tab.

When verifying a server change, compare the live socket's Hello `buildId` with
the new `pragma-server` binary's SHA-256. Dev desktop relaunch/HMR preserves a
same-protocol daemon, so a freshly built app may still use yesterday's host.
Restart Server closes live terminal tabs: check for sessions and get the user's
approval before using it when terminals are running. Never restart production
to refresh a worktree's separate dev host.
