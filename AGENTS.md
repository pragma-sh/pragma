# Pragma — Agent & Contributor Guide

> This file is the single source of truth for repo-wide rules. `CLAUDE.md` is a symlink
> to it. Each package/app/crate has its own `AGENTS.md` with deeper specifics — read the
> relevant one before touching that area.

## What is Pragma?

Pragma is a **macOS + Linux desktop app** (Tauri v2) that hosts AI coding agents in
persistent, worktree-scoped terminal sessions. It manages git worktrees as first-class
workspaces, proxies PTY I/O through a detached Unix-socket daemon, and surfaces agent
status (running / attention / done) in real time. Plugins for opencode and Claude Code
report their status back through the `pragma-agent` CLI.

## North star: clean, reusable, consistent

The overriding priority is a **clean, reusable architecture** with **consistent rules
across TypeScript and Rust**. When you write code:

- **Reuse before you write.** Search for an existing helper, component, or constant
  first. Lift duplicated logic into a shared location the moment it appears twice.
- **Do not be afraid to create a new package or directory.** If something is shared,
  or _could_ be shared, give it a home (`packages/*`). If a value is referenced in
  more than one place, it belongs in `@pragma/constants`, not inline. Small,
  single-purpose packages are encouraged.
- **One source of truth.** Never copy a value across the TS/Rust boundary by hand —
  put it in `@pragma/constants` (see `packages/constants/AGENTS.md`).
- **Keep the two languages in lockstep.** The same concept should be named, layered,
  and error-handled the same way in TypeScript and Rust. See _Code standards_ below.
- **Suggest sweeping changes.** This project is early. If you see a cleaner structure,
  propose and make it — restructuring for clarity is welcome, not discouraged.
- **Plugins stay out of core — ask first.** A plugin/agent package (`packages/*-plugin`)
  is **self-contained data plus its own bundled assets**. It must **not** add or modify
  code in pragma core (`apps/pragma`, including `src-tauri`), the daemon
  (`crates/pragma-daemon`), the UI, the CLI (`crates/pragma-agent-cli`), or the SDK
  (`packages/sdk`) **without explicit owner permission**. A plugin **installs itself
  through its host tool's own plugin mechanism**, never through per-plugin Pragma code.
  The only Pragma-side install is the **generic** launcher step
  (`agents::ensure_bundled_installed` copies `pragma/agents/*` into `~/.pragma/agents`).
  There are deliberately **no** per-plugin core files: the old `opencode_plugin.rs` /
  `claude_plugin.rs` installers were **removed**. If a plugin genuinely needs new core
  behavior, **stop and ask** first.

## Keeping this guide current (self-improvement)

**This document is living. If it is wrong, stale, or incomplete, fix it as part of your
change — that is expected, not optional.** A guide that drifts from reality is worse
than no guide.

- **Edit the relevant AGENTS.md in the same change that makes it outdated.** Add a
  package, move a file, change a command, bump a tool, adopt a new pattern → update the
  matching AGENTS.md (root and/or child) in the same commit. Because `CLAUDE.md` is a
  symlink to the root AGENTS.md, both humans and agents stay in sync automatically.
- **Mirror it in the skills.** The `.agents/skills/*` files (symlinked to
  `.claude/skills/`) summarize parts of this guide. If you change a workflow here,
  update the relevant skill (`pragma-architecture`, `shared-constants`, `tauri-command`,
  `code-quality`) too, and add a new skill when you add a substantial new workflow.
- **When you discover something the hard way, write it down.** A non-obvious gotcha, a
  setup step, a "don't do X because Y" — capture it here (or in the relevant child
  AGENTS.md) so the next person (or agent) doesn't rediscover it.
- **Prefer fixing the guide over working around it.**
- **Keep it concise.** Prune advice that no longer applies. Length is not authority;
  accuracy is.

## Tech stack

| Concern          | Choice                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo / tasks | [Turborepo](https://turbo.build) + [Bun](https://bun.sh) workspaces                                                                                             |
| Desktop shell    | [Tauri v2](https://v2.tauri.app) (targets: **macOS + Linux only**)                                                                                              |
| Frontend         | [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript                                                                                           |
| Styling / UI     | [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) + `@tailwindcss/typography` (`prose`)                                           |
| Backend          | Rust (Tauri commands)                                                                                                                                           |
| GitHub           | Octokit (JS, in `lib/github.ts` only) + `reqwest` (Rust auth, `0600` token file); TipTap + react-markdown for PR bodies                                         |
| AI               | pi coding-agent SDK (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`) wrapped by `@pragma/ai-helpers`, run via the Bun-compiled `pragma-ai` sidecar |
| Shared constants | JSON Schema → typed TS (`json-schema-to-typescript`) + Rust (`typify`)                                                                                          |
| SDK bundling     | [Bunup](https://bunup.dev) for dual ESM/CJS library output + `.d.ts`                                                                                            |
| Lint (TS)        | [oxlint](https://oxc.rs)                                                                                                                                        |
| Format (TS)      | [oxfmt](https://oxc.rs)                                                                                                                                         |
| Lint (Rust)      | clippy (`-D warnings`, `all` + `pedantic`)                                                                                                                      |
| Format (Rust)    | rustfmt                                                                                                                                                         |
| Tests            | Vitest (TS) + `cargo test` (Rust)                                                                                                                               |
| Commits          | Conventional Commits (commitlint)                                                                                                                               |
| Git hooks        | Husky + lint-staged                                                                                                                                             |
| CI               | GitHub Actions (`.github/workflows/ci.yml`)                                                                                                                     |

## Repository structure

```
.
├── apps/
│   └── pragma/                  # Tauri desktop app → see apps/pragma/AGENTS.md
├── crates/
│   ├── pragma-agent-cli/        # `pragma-agent` CLI → see crates/pragma-agent-cli/AGENTS.md
│   ├── pragma-daemon/           # Detached Unix-socket PTY daemon → see crates/pragma-daemon/AGENTS.md
│   └── pragma-protocol/         # Shared wire frames → see crates/pragma-protocol/AGENTS.md
├── packages/
│   ├── constants/               # Dual TS + Rust shared constants → see packages/constants/AGENTS.md
│   ├── sdk/                     # `@pragma/sdk` Node/Bun wrapper → see packages/sdk/AGENTS.md
│   ├── opencode-plugin/         # opencode integration → see packages/opencode-plugin/AGENTS.md
│   ├── claude-code-plugin/      # Claude Code integration → see packages/claude-code-plugin/AGENTS.md
│   └── cursor-plugin/           # Cursor Agent CLI integration → see packages/cursor-plugin/AGENTS.md
│   ├── constants/               # Dual TS + Rust package — shared source of truth
│   ├── sdk/                     # `@pragma/sdk` typed Node/Bun wrapper around `pragma-agent`
│   ├── ai-helpers/              # `@pragma/ai-helpers` — wraps the pi coding-agent SDK (auth, pickModel, prompts); `src/cli.ts` is the `pragma-ai` sidecar
│   └── opencode-plugin/         # `@pragma/opencode-plugin` ESM opencode plugin + bundled Pragma agent config
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
- A typed JS wrapper over the bundled agent CLI → `packages/sdk` (`@pragma/sdk`).
- A reusable UI primitive → `apps/pragma/src/components/ui/` (prefer `shadcn add`).
- Anything that calls the Rust backend → `apps/pragma/src/lib/tauri.ts` (never call
  `invoke()` directly from components).
- GitHub REST/GraphQL → `apps/pragma/src/lib/github.ts` only (never instantiate Octokit
  in components). See `apps/pragma/AGENTS.md`.
- PTY/session business logic → `crates/pragma-daemon`; wire framing → `crates/pragma-protocol`;
  agent status CLI → `crates/pragma-agent-cli`. The Tauri app only proxies over the socket.

## Common commands

All commands run from the repo root unless noted. We use **bun** as the package
manager and **turbo** as the task runner.

```bash
bun install                # Install all workspace deps

# App
bun run dev                # Run the desktop app (Tauri dev, "Pragma Dev" branding)
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
cargo run -p pragma-agent-cli -- --agent dev report started # Manually send an agent report (inside a Pragma terminal env)
```

## Code standards (consistent across TypeScript & Rust)

Formatting is **automated and non-negotiable** — oxfmt for TS, rustfmt for Rust. Don't
argue with the formatter; run it. Both are enforced in CI and auto-applied on commit.

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
  `?`; reserve `expect`/`panic!` for genuinely-unrecoverable startup invariants.
- **No magic values.** Cross-boundary values live in `@pragma/constants`. Frontend-only
  shared values live in `src/lib/`.
- **Imports are grouped** (oxfmt/rustfmt enforce ordering): external deps, then
  workspace packages, then local/relative.
- **Public items are documented.** Exported TS functions/types get a JSDoc line; public
  Rust items get a `///` doc comment.
- **Keep the IPC surface typed and centralized.** Every Tauri command has a matching
  typed wrapper in `src/lib/tauri.ts` and a `#[tauri::command]` in `src-tauri/src/lib.rs`
  with the same name.

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
- **pre-push:** full `typecheck` + `cargo fmt --check` + sidecar staging +
  `cargo check`.

CI re-verifies everything in **check** mode (it never auto-fixes): commitlint, oxlint,
oxfmt `--check`, typecheck, `cargo fmt --check`, clippy, both test suites, and a
compile-only Tauri build on macOS **and** Linux.

## Platform targets

We target **macOS and Linux only** right now. `tauri.conf.json` bundles `app`/`dmg`
(macOS) and `deb`/`rpm`/`appimage` (Linux). Don't add Windows/Android specifics without
updating this guide and CI. Linux builds need the GTK/WebKit system libraries — see the
`rust`/`build` jobs in CI for the exact `apt` list. `xcap` pulls in `libspa-sys`
(`libpipewire-0.3-dev`), `libgbm-dev`, and `libclang-dev` — all required at link time
on Linux and must stay in the CI apt list.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
