# Pragma — Agent & Contributor Guide

> This file is the single source of truth for how we build in this repo. `CLAUDE.md`
> is a symlink to it. Read it before making changes. Keep it up to date — if you
> change a pattern, change it here too.

## North star: clean, reusable, consistent

The overriding priority for this project is a **clean, reusable architecture** with
**consistent rules across TypeScript and Rust**. When you write code:

- **Reuse before you write.** Search for an existing helper, component, or constant
  first. Lift duplicated logic into a shared location the moment it appears twice.
- **Do not be afraid to create a new package or directory.** If something is shared,
  or _could_ be shared, give it a home (`packages/*`). If a value is referenced in
  more than one place, it belongs in `@pragma/constants`, not inline. Small,
  single-purpose packages are encouraged.
- **One source of truth.** Never copy a value across the TS/Rust boundary by hand —
  put it in `@pragma/constants` (see below).
- **Keep the two languages in lockstep.** The same concept should be named, layered,
  and error-handled the same way in TypeScript and Rust. See _Code standards_.
- **Suggest sweeping changes.** This project is early. If you see a cleaner structure,
  propose and make it — restructuring for clarity is welcome, not discouraged.

## Keeping this guide current (self-improvement)

**This document is living. If it is wrong, stale, or incomplete, fix it as part of your
change — that is expected, not optional.** A guide that drifts from reality is worse
than no guide.

- **Edit AGENTS.md in the same change that makes it outdated.** Add a package, move a
  file, change a command, bump a tool, adopt a new pattern → update the matching
  section (tech-stack table, repo map, commands, code standards) in the same commit.
  Because `CLAUDE.md` is a symlink to this file, both humans and agents stay in sync
  automatically.
- **Mirror it in the skills.** The `.agents/skills/*` files (symlinked to
  `.claude/skills/`) summarize parts of this guide. If you change a workflow here,
  update the relevant skill (`pragma-architecture`, `shared-constants`, `tauri-command`,
  `code-quality`) too, and add a new skill when you add a substantial new workflow.
- **When you discover something the hard way, write it down.** A non-obvious gotcha, a
  setup step, a "don't do X because Y" — capture it here so the next person (or agent)
  doesn't rediscover it.
- **Prefer fixing the guide over working around it.** If reality and this document
  disagree, decide which is correct: change the code to match the documented standard,
  or change the document to match the better reality — never leave them contradicting.
- **Keep it concise.** Prune advice that no longer applies. Length is not authority;
  accuracy is.

## Tech stack

| Concern          | Choice                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| Monorepo / tasks | [Turborepo](https://turbo.build) + [Bun](https://bun.sh) workspaces             |
| Desktop shell    | [Tauri v2](https://v2.tauri.app) (targets: **macOS + Linux only**)              |
| Frontend         | [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript           |
| Styling / UI     | [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) |
| Backend          | Rust (Tauri commands)                                                           |
| Shared constants | JSON Schema → typed TS (`json-schema-to-typescript`) + Rust (`typify`)          |
| Lint (TS)        | [oxlint](https://oxc.rs)                                                        |
| Format (TS)      | [oxfmt](https://oxc.rs)                                                         |
| Lint (Rust)      | clippy (`-D warnings`, `all` + `pedantic`)                                      |
| Format (Rust)    | rustfmt                                                                         |
| Tests            | Vitest (TS) + `cargo test` (Rust)                                               |
| Commits          | Conventional Commits (commitlint)                                               |
| Git hooks        | Husky + lint-staged                                                             |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                                     |

## Repository structure

```
.
├── apps/
│   └── pragma/                  # The Tauri desktop app
│       ├── src/                 # React frontend (TypeScript)
│       │   ├── components/      # Workspace shell, sidebar, tab strip, dialogs, terminal host
│       │   ├── components/ui/   # shadcn/ui primitives (generated; avoid hand-edits)
│       │   ├── lib/             # Reusable, framework-agnostic helpers
│       │   │   ├── tauri.ts     # Typed bridge to Rust commands — the ONLY place invoke() is called
│       │   │   ├── terminal-manager.ts # Non-React xterm registry; terminal output bypasses React state
│       │   │   └── utils.ts     # cn() + small utilities
│       │   ├── state/           # Workspace context/reducer for projects/worktrees/tabs only
│       │   ├── test/setup.ts    # Vitest setup
│       │   ├── App.tsx
│       │   └── main.tsx
│       └── src-tauri/           # Rust backend
│           ├── src/lib.rs       # App wiring, managed state, plugins, command registration
│           ├── src/db.rs        # SQLite migrations + typed CRUD
│           ├── src/pty.rs       # Detached daemon client + PTY command proxying
│           ├── src/git.rs       # Git CLI helpers
│           ├── src/main.rs      # Thin entrypoint
│           └── tauri.conf.json  # Window/bundle config (mirror values from @pragma/constants)
├── crates/
│   └── pragma-daemon/           # Detached Unix-socket PTY daemon; owns shell sessions + scrollback
├── packages/
│   └── constants/               # Dual TS + Rust package — shared source of truth
│       ├── schema.json          # JSON Schema (the contract). EDIT THIS to change shape.
│       ├── values.json          # The actual values. EDIT THIS to change values.
│       ├── src/index.ts         # Typed TS export
│       ├── src/lib.rs           # Rust export (typify-generated types + parsed values)
│       └── src/generated/       # Generated TS types (git-ignored; never edit)
├── tsconfig.base.json           # Shared strict TS config (every package extends it)
├── Cargo.toml                   # Rust workspace (shared deps + lints + release profile)
├── rustfmt.toml                 # Rust formatting rules
├── turbo.json                   # Task graph
├── commitlint.config.js         # Conventional Commits rules
├── .oxlintrc.json / .oxfmtrc.json
├── .husky/                      # Git hooks
└── .agents/skills/              # Agent skills (symlinked to .claude/skills)
```

**Where things go:**

- A value used by both frontend and backend → `packages/constants` (`values.json`).
- A value/helper used by multiple frontend modules → `apps/pragma/src/lib/`.
- A helper/type that could be reused by a future app → a new `packages/*` package.
- A reusable UI primitive → `apps/pragma/src/components/ui/` (prefer `shadcn add`).
- Anything that calls the Rust backend → `apps/pragma/src/lib/tauri.ts` (never call
  `invoke()` directly from components).
- PTY/session business logic → `crates/pragma-daemon`; the Tauri app only proxies over
  the Unix socket and must not own PTYs.
- Terminal output → xterm in `src/lib/terminal-manager.ts`; never route it through
  React state or the workspace reducer.
- **Terminal font** is a Nerd Font-first stack (`JetBrainsMonoNL Nerd Font`,
  `JetBrainsMono Nerd Font`, `JetBrains Mono`, `SF Mono`, Menlo, Monaco,
  `ui-monospace`, `monospace`) at **fontSize 14 / lineHeight 1.0**. 14px is the
  size Nerd Font's block / box-drawing glyphs are designed against — at 13px
  macOS WebKit rounds the cell to 15px and the half-block glyphs end up with a
  1px anti-aliased seam running through the middle of every character (visible
  strikethrough across Claude Code / opencode ASCII art). 14px snaps the cell
  to a cleaner integer pixel grid. See `TERMINAL_FONT_FAMILY`,
  `TERMINAL_FONT_SIZE`, `TERMINAL_LINE_HEIGHT` in `terminal-manager.ts`.

## Common commands

All commands run from the repo root unless noted. We use **bun** as the package
manager and **turbo** as the task runner.

```bash
bun install                # Install all workspace deps

# App
bun run dev                # Run the desktop app — native window + Vite (Tauri dev)
bun run --filter pragma tauri:build   # Build the desktop app (macOS/Linux bundles)

# Quality gates (root)
bun run lint               # oxlint across the repo
bun run format             # oxfmt --write (auto-fix formatting)
bun run format:check       # oxfmt --check (CI)
bun run typecheck          # turbo: generate constants -> tsc across packages
bun run test               # turbo: Vitest across packages
bun run rust:fmt           # cargo fmt --all
bun run rust:clippy        # cargo clippy -D warnings
bun run rust:test          # cargo test --workspace
bun run check              # Everything CI checks, in one shot

bun run generate           # Regenerate shared-constant types from schema/values
cargo run -p pragma-daemon # Run the detached PTY daemon directly for debugging
```

## Code standards (consistent across TypeScript & Rust)

Formatting is **automated and non-negotiable** — oxfmt for TS, rustfmt for Rust. Don't
argue with the formatter; run it. Both are enforced in CI and auto-applied on commit.
The conventions below are the parts the formatter can't decide for you, and they are
deliberately mirrored across the two languages.

| Concept            | TypeScript                                        | Rust                                                          |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------- |
| Variables / fns    | `camelCase`                                       | `snake_case`                                                  |
| Types / components | `PascalCase`                                      | `PascalCase`                                                  |
| Constants          | `UPPER_SNAKE` (true consts) / `camelCase` objects | `UPPER_SNAKE`                                                 |
| Files              | `kebab-case.ts`, `PascalCase.tsx` (components)    | `snake_case.rs`                                               |
| JSON keys (wire)   | `camelCase` (canonical)                           | `camelCase` on the wire; `snake_case` fields via serde rename |
| Module boundaries  | One responsibility per file/module                | One responsibility per file/module                            |

Shared rules:

- **Strictness is on, everywhere.** TS runs in `strict` mode with
  `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc. Rust runs clippy
  `all` + `pedantic` as `-D warnings` and `unsafe_code = "forbid"`. Treat warnings as
  errors. Don't silence a lint without a comment explaining why.
- **Errors are values, surfaced explicitly.** TS: prefer returning/throwing typed
  errors and narrowing with `instanceof`; never swallow. Rust: return `Result`, use
  `?`; reserve `expect`/`panic!` for genuinely-unrecoverable startup invariants (and
  write the invariant in the message, as `CONSTANTS` does).
- **No magic values.** Cross-boundary values live in `@pragma/constants`. Frontend-only
  shared values live in `src/lib/`.
- **Imports are grouped** (oxfmt/rustfmt enforce ordering): external deps, then
  workspace packages, then local/relative. Keep side-effect imports (CSS, test setup)
  explicit.
- **Public items are documented.** Exported TS functions/types get a JSDoc line; public
  Rust items get a `///` doc comment.
- **Keep the IPC surface typed and centralized.** Every Tauri command has a matching
  typed wrapper in `src/lib/tauri.ts` and a `#[tauri::command]` in `src-tauri/src/lib.rs`
  with the same name. Share the payload types via `@pragma/constants` where possible.

## Shared constants workflow (the single source of truth)

`packages/constants` is consumed by **both** the React frontend and the Rust backend.
To add or change a shared value:

1. Edit `packages/constants/schema.json` (the shape/contract).
2. Edit `packages/constants/values.json` (the value). It must satisfy the schema.
3. Run `bun run generate` (TS types regenerate, including unreferenced schema
   definitions; Rust regenerates on next build).
4. Use it:
   - **TS:** `import { constants } from "@pragma/constants"` → `constants.app.name`
   - **Rust:** `pragma_constants::CONSTANTS.app.name`

The Rust side parses `values.json` against the schema-generated types at startup and
**panics loudly** if they ever drift apart — that's intentional. If you change window
defaults or the app identifier here, mirror them in `src-tauri/tauri.conf.json`
(Tauri reads its config statically; keep the two in sync).

## Adding a Tauri command (frontend ⇄ backend)

1. **Rust** (`src-tauri/src/lib.rs`): write `#[tauri::command] fn my_command(...) -> T`
   and register it in `tauri::generate_handler![...]`. Prefer payload/return types from
   `@pragma/constants` so the contract is shared.
2. **TS** (`src/lib/tauri.ts`): add a typed wrapper
   `export function myCommand(...): Promise<T> { return invoke<T>("my_command", ...) }`.
3. **Components** import the wrapper — never call `invoke()` directly.
4. Add a Vitest that mocks `@tauri-apps/api/core` and a `cargo test` for the Rust logic.

## UI: Tailwind v4 + shadcn/ui

- Add primitives with `bunx shadcn@latest add <component>` (writes to
  `src/components/ui/`). Don't hand-roll what shadcn provides.
- Compose primitives into feature components elsewhere in `src/`; keep `components/ui`
  for unmodified primitives.
- Use the `cn()` helper (`src/lib/utils.ts`) for conditional classes. Theme tokens live
  in `src/index.css` (`@theme`/CSS variables) — use semantic tokens (`bg-background`,
  `text-muted-foreground`), not raw colors.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), enforced locally and in CI:

```
<type>(<scope>): <subject>
```

- **types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scope:** optional; prefer a package/app name (`pragma`, `constants`, `ci`, `deps`)
- Examples: `feat(pragma): add settings window`, `fix(constants): correct min width`

## Git hooks (Husky)

- **pre-commit:** `lint-staged` auto-fixes staged files (`oxlint --fix`, `oxfmt --write`,
  `rustfmt`). Fixing — not just checking — is the local behavior.
- **commit-msg:** commitlint validates the message.
- **pre-push:** full `typecheck` + `cargo fmt --check` + `cargo check`.

CI re-verifies everything in **check** mode (it never auto-fixes): commitlint, oxlint,
oxfmt `--check`, typecheck, `cargo fmt --check`, clippy, both test suites, and a
compile-only Tauri build on macOS **and** Linux.

## Platform targets

We target **macOS and Linux only** right now. `tauri.conf.json` bundles
`app`/`dmg` (macOS) and `deb`/`rpm`/`appimage` (Linux). Don't add Windows/Android
specifics without updating this guide and CI. Linux builds need the GTK/WebKit system
libraries — see the `rust`/`build` jobs in CI for the exact `apt` list.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
