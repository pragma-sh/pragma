# Pragma — Agent & Contributor Guide

> This file is the single source of truth for repo-wide rules. `CLAUDE.md` is a symlink
> to it. Each package/app/crate has its own `AGENTS.md` with deeper specifics — read the
> relevant one before touching that area.

## What is Pragma?

Pragma is a **macOS + Linux + Windows desktop app** (Tauri v2) moving toward a
host-server + thin native-client architecture. The host runs persistent, worktree-scoped
terminal sessions through `pragma-server`; native clients connect over a local Unix
socket (on all three platforms), or over a bridge that presents a remote SSH host or a
WSL distribution as one. Plugins for opencode, Claude Code, and Cursor report status through
the `pragma-cli` helper.

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
- **Host-tool plugins stay out of core — ask first.** A host-tool plugin/agent package
  (`packages/*-plugin`, such as opencode/Claude/Cursor integrations) is
  **self-contained data plus its own bundled assets**. It must **not** add or modify code
  in pragma core (`apps/pragma`, including `src-tauri`), the server
  (`crates/pragma-server`), the UI, the CLI (`crates/pragma-cli`), or the SDK
  (`packages/sdk`) **without explicit owner permission**. A host-tool plugin installs
  itself through its host tool's own plugin mechanism, never through per-plugin Pragma
  code. Launchable Pragma agents are contributed through the `@pragma/plugin`
  `defineAgent` API (or the built-in Pragma plugin), not per-tool JSON files copied by
  core. There are deliberately **no** per-tool core installers: the old
  `opencode_plugin.rs` / `claude_plugin.rs` installers were **removed**. The generic
  Pragma plugin runtime is the exception: infrastructure for `.pragma/config.json` plugins lives in
  `packages/plugin`, `apps/pragma/src/plugins`, and `apps/pragma/src-tauri/src/plugins.rs`.

## Keeping this guide current (self-improvement)

**This document is living. If it is wrong, stale, or incomplete, fix it as part of your
change — that is expected, not optional.** A guide that drifts from reality is worse
than no guide.

- **Edit the relevant AGENTS.md in the same change that makes it outdated.** Add a
  package, move a file, change a command, bump a tool, adopt a new pattern → update the
  matching AGENTS.md (root and/or child) in the same commit. Because `CLAUDE.md` is a
  symlink to the root AGENTS.md, both humans and agents stay in sync automatically.
- **Mirror it in the skills.** Canonical first-party skill sources live under `skills/`
  and are symlinked into `.agents/skills/` (which `.claude/skills` also exposes). If you
  change a workflow here, update the relevant skill (`pragma-architecture`,
  `shared-constants`, `tauri-command`, `code-quality`, `agent-plugin`) too, and add a new
  skill when you add a substantial new workflow.
- **When you discover something the hard way, write it down.** A non-obvious gotcha, a
  setup step, a "don't do X because Y" — capture it here (or in the relevant child
  AGENTS.md) so the next person (or agent) doesn't rediscover it.
- **Prefer fixing the guide over working around it.**
- **Keep it concise.** Prune advice that no longer applies. Length is not authority;
  accuracy is.

## Tech stack

| Concern           | Choice                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo / tasks  | [Turborepo](https://turbo.build) + [Bun](https://bun.sh) workspaces                                                                                             |
| Desktop shell     | [Tauri v2](https://v2.tauri.app) (targets: **macOS, Linux, Windows**)                                                                                           |
| Frontend          | [Vite](https://vite.dev) + [React 19](https://react.dev) + TypeScript                                                                                           |
| Styling / UI      | [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) + `@tailwindcss/typography` (`prose`)                                           |
| Backend           | Rust (Tauri commands)                                                                                                                                           |
| GitHub            | Octokit (JS, in `lib/github.ts` only) + `reqwest` (Rust auth, `0600` token file); TipTap + react-markdown for PR bodies                                         |
| AI                | pi coding-agent SDK (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`) wrapped by `@pragma/ai-helpers`, run via the Bun-compiled `pragma-ai` sidecar |
| Automations       | `@pragma/automations` authoring API + Bun-compiled `pragma-automations` sidecar, supervised by `pragma-server`                                                  |
| Shared constants  | JSON Schema → typed TS (`json-schema-to-typescript`) + Rust (`typify`)                                                                                          |
| SDK bundling      | [Bunup](https://bunup.dev) for dual ESM/CJS library output + `.d.ts`                                                                                            |
| Lint (TS)         | [oxlint](https://oxc.rs)                                                                                                                                        |
| Format (TS)       | [oxfmt](https://oxc.rs)                                                                                                                                         |
| Lint (Rust)       | clippy (`-D warnings`, `all` + `pedantic`)                                                                                                                      |
| Format (Rust)     | rustfmt                                                                                                                                                         |
| Tests             | Vitest (TS) + `cargo test` (Rust)                                                                                                                               |
| Commits           | Conventional Commits (commitlint)                                                                                                                               |
| Git hooks         | Husky + lint-staged                                                                                                                                             |
| CI                | GitHub Actions (`.github/workflows/ci.yml`)                                                                                                                     |
| Code intelligence | [fallow](https://fallow.tools) — dead-code / duplication / complexity audit (TS/JS only); config in `.fallowrc.jsonc`                                           |

## Repository structure

```
.
├── apps/
│   ├── pragma/                  # Tauri desktop app → see apps/pragma/AGENTS.md
│   └── pragma-mobile/           # Expo (SDK 57) native client → see apps/pragma-mobile/AGENTS.md
├── crates/
│   ├── pragma-cli/              # `pragma-cli` CLI → see crates/pragma-cli/AGENTS.md
│   ├── pragma-client/           # Native client frame I/O + SSH bridge → see crates/pragma-client/AGENTS.md
│   ├── pragma-core/             # Host business logic boundary → see crates/pragma-core/AGENTS.md
│   ├── pragma-gateway/          # Localhost HTTP gateway → see crates/pragma-gateway/AGENTS.md
│   ├── pragma-platform/         # OS seams: IPC, permissions, processes, shells → see crates/pragma-platform/AGENTS.md
│   ├── pragma-protocol/         # Shared wire frames → see crates/pragma-protocol/AGENTS.md
│   └── pragma-server/           # Persistent host server (local socket) → see crates/pragma-server/AGENTS.md
├── packages/
│   ├── constants/               # Dual TS + Rust shared constants → see packages/constants/AGENTS.md
│   ├── sdk/                     # `@pragma/sdk` Node/Bun wrapper → see packages/sdk/AGENTS.md
│   ├── plugin/                  # `@pragma/plugin` public plugin API/runtime stub → see packages/plugin/AGENTS.md
│   ├── automations/             # `@pragma/automations` authoring API + sidecar runner → see packages/automations/AGENTS.md
│   ├── create-pragma-plugin/    # Plugin scaffolder CLI → see packages/create-pragma-plugin/AGENTS.md
│   ├── github-helpers/          # `pragma-github` sidecar → see packages/github-helpers/AGENTS.md
│   ├── sidecar-kit/             # `@pragma/sidecar-kit` shared NDJSON stdin helpers for host sidecars → see packages/sidecar-kit/AGENTS.md
│   ├── opencode-plugin/         # opencode integration → see packages/opencode-plugin/AGENTS.md
│   ├── claude-code-plugin/      # Claude Code integration → see packages/claude-code-plugin/AGENTS.md
│   ├── cursor-plugin/           # Cursor Agent CLI integration → see packages/cursor-plugin/AGENTS.md
│   ├── codex-plugin/            # OpenAI Codex CLI integration → see packages/codex-plugin/AGENTS.md
│   ├── pi-plugin/               # Pi CLI integration → see packages/pi-plugin/AGENTS.md
│   ├── plugins-host/            # `@pragma/plugins-host` plugin catalog sidecar (`pragma-plugins`) → see packages/plugins-host/AGENTS.md
│   └── dev-test-plugin/         # `@pragma/dev-test-plugin` sample plugin (sidebar tabs/cards + web view + SDK event hook) → see packages/dev-test-plugin/AGENTS.md
│   ├── constants/               # Dual TS + Rust package — shared source of truth
│   ├── sdk/                     # `@pragma/sdk` typed Node/Bun wrapper around `pragma-cli`
│   ├── automations/             # `@pragma/automations` API + `pragma-automations` host sidecar
│   ├── ai-helpers/              # `@pragma/ai-helpers` — wraps the pi coding-agent SDK (auth, pickModel, prompts); `src/cli.ts` is the `pragma-ai` sidecar
│   ├── github-helpers/          # `@pragma/github-helpers` — Octokit host sidecar; `src/cli.ts` is `pragma-github`
│   ├── opencode-plugin/         # `@pragma/opencode-plugin` ESM opencode status plugin
│   └── plugins-host/            # `@pragma/plugins-host` — `pragma-plugins` host sidecar (agent catalog + icon assets)
├── skills/                       # Canonical first-party skill sources; symlinked into `.agents/skills`
├── tsconfig.base.json           # Shared strict TS config (every package extends it)
├── Cargo.toml                   # Rust workspace (shared deps + lints + release profile)
├── rustfmt.toml                 # Rust formatting rules
├── turbo.json                   # Task graph
├── commitlint.config.js         # Conventional Commits rules
├── .oxlintrc.json / .oxfmtrc.json
├── .husky/                      # Git hooks
└── .agents/skills/              # Installed skill view (also exposed through .claude/skills)
```

**Where things go:**

- User-tunable global settings live in `~/.pragma/config.json` (plugins under `plugins[]`,
  remote-access tunnel under `tunnel` = `{ command, urlPattern }`). Shipped defaults for
  such settings belong in `@pragma/constants` (e.g. `tunnel.defaultCommand`) so Rust and TS
  agree, never hard-coded in one language.
- Desktop Settings is a full-frame UI wrapper over global/project `.pragma/config.json`;
  native `Cmd+,` opens it on macOS. Host-only mobile pairing and gateway device history
  live under its global scope.
- A value used by both frontend and backend → `packages/constants` (`values.json`).
- A value/helper used by multiple frontend modules → `apps/pragma/src/lib/`.
- A helper/type that could be reused by a future app → a new `packages/*` package.
- A typed JS wrapper over the bundled Pragma CLI → `packages/sdk` (`@pragma/sdk`).
- Public APIs for pure TypeScript Pragma plugins → `packages/plugin` (`@pragma/plugin`).
- Plugin templates/scaffolding → `packages/create-pragma-plugin`.
- A pure-TS sample/exercise plugin (sidebar tab, sidebar card, web view, SDK event hook) →
  `packages/dev-test-plugin` (`@pragma/dev-test-plugin`).
- A reusable UI primitive → `apps/pragma/src/components/ui/` (prefer `shadcn add`).
- Anything that calls the Rust backend → `apps/pragma/src/lib/tauri.ts` (never call
  `invoke()` directly from components).
- GitHub REST/GraphQL → `apps/pragma/src/lib/github.ts` only (never instantiate Octokit
  in components). See `apps/pragma/AGENTS.md`.
- PTY/session ownership → `crates/pragma-server`; native client frame I/O / SSH and WSL
  bridges → `crates/pragma-client`; localhost HTTP/JSON translation →
  `crates/pragma-gateway`; host business logic → `crates/pragma-core`; wire framing →
  `crates/pragma-protocol`; CLI/status reporting → `crates/pragma-cli`.
- Anything that differs between operating systems → `crates/pragma-platform`. Never a
  bare `#[cfg(unix)]` at the call site (see _Platform targets_).

## Common commands

All commands run from the repo root unless noted. We use **bun** as the package
manager and **turbo** as the task runner.

```bash
bun install                # Install all workspace deps

# App
bun run dev                # Run the desktop app (Tauri dev, "Pragma Dev" branding)
bun run dev:command -- <dev-id> "<command>" # Open command in a new terminal tab in that dev build
bun run --filter pragma tauri:build   # Build the desktop app (macOS/Linux/Windows bundles)

# Mobile app (Expo, apps/pragma-mobile) — see apps/pragma-mobile/AGENTS.md
bun run dev:mobile:ios     # First run: build dev client + boot iOS simulator
bun run dev:mobile:android # First run: build dev client + boot Android emulator
bun run dev:mobile         # Metro dev server (after the dev client is installed once)

# Quality gates (root)
bun run lint               # oxlint across the repo
bun run format             # oxfmt --write (auto-fix formatting)
bun run format:check       # oxfmt --check (CI)
bun run typecheck          # turbo: generate constants -> tsc across packages
bun run test               # turbo: Vitest across packages
bun run rust:fmt           # cargo fmt --all
bun run rust:clippy        # cargo clippy -D warnings
bun run rust:test          # cargo test --workspace
bun run fallow:check       # fallow audit (TS/JS): block on issues this branch introduces
bun run check              # Everything CI checks, in one shot

bun run generate           # Regenerate shared-constant types from schema/values
cargo run -p pragma-server # Run the persistent server directly for debugging
cargo run -p pragma-gateway -- --socket /path/to/daemon.sock # Run the localhost HTTP gateway
cargo run -p pragma-cli -- agent report --agent dev started # Manually send an agent report (inside a Pragma terminal env)
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
  `cargo check` + `fallow:check` (fallow audit, blocks on TS/JS issues this branch
  introduces vs `main`).

CI re-verifies everything in **check** mode (it never auto-fixes): commitlint, oxlint,
oxfmt `--check`, typecheck, `cargo fmt --check`, clippy, both test suites, and a
compile-only Tauri build on macOS, Linux, **and** Windows. A separate **Fallow** workflow
(`.github/workflows/fallow.yml`) runs `fallow audit` on each PR via the
`fallow-rs/fallow@v2` action — it scopes to the PR diff, posts a summary comment plus
inline annotations, and fails the check on issues the PR introduces.

## Platform targets

We target **macOS, Linux, and Windows**. `tauri.conf.json` bundles `app`/`dmg` (macOS),
`deb`/`rpm`/`appimage` (Linux), and `msi`/`nsis` (Windows). Don't add Android specifics
without updating this guide and CI.

- **Linux** builds need the GTK/WebKit system libraries — see the `rust`/`build` jobs in
  CI for the exact `apt` list. `xcap` pulls in `libspa-sys` (`libpipewire-0.3-dev`),
  `libgbm-dev`, and `libclang-dev` — all required at link time and must stay in that list.
- **Windows** needs no system packages: the webview is WebView2, which ships with the OS
  on Windows 11 and with the Edge runtime on Windows 10. CI covers it with the
  `rust-windows` job plus a `windows-latest` entry in the `build` matrix.

**Never add a `#[cfg(unix)]` block with a silently-empty `#[cfg(not(unix))]` twin.** That
pattern is how a security guarantee quietly disappears — it is exactly what let the
GitHub token be written world-readable on Windows. Platform differences belong in
`crates/pragma-platform`, which owns four seams and has a real implementation for each
on every target:

| Seam      | What it owns                                                             |
| --------- | ------------------------------------------------------------------------ |
| `ipc`     | The local socket: `AF_UNIX` everywhere, `uds_windows` on Windows         |
| `perms`   | Owner-only files/dirs: `0600`/`0700` on Unix, an `icacls` ACL on Windows |
| `process` | Kill, kill-tree, liveness, and the process table                         |
| `shell`   | Which shell a PTY launches, and its interactive arguments                |

### Windows session modes

Windows runs terminals in one of two worlds, and they are served differently:

- **PowerShell** — a Windows-native `pragma-server.exe` drives ConPTY through
  `portable-pty`. `pwsh.exe` is preferred over `powershell.exe`; note PowerShell takes
  `-NoLogo`, **not** the POSIX `-l`.
- **WSL** — the ordinary Linux `pragma-server` runs _unchanged inside the distribution_
  and is reached like a remote host. This is not an implementation detail to optimise
  away: the agent plugins (`pragma-cli`, the opencode and Claude hooks) run inside WSL
  and connect to that Linux Unix socket, so a Windows-native server could never serve
  them. WSL2 cannot reach a Windows named pipe and Windows cannot open the Linux socket,
  so the bridge relays over the standard streams of a `wsl.exe` process
  (`pragma-server --relay`). See `crates/pragma-client/src/wsl.rs` for why that beat
  forwarding a port over localhost.

A project selects its shell in `.pragma/config.json` under `terminal.shell`; defaults
live in `@pragma/constants` under `platform`.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
