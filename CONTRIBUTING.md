# Contributing to Pragma

Thanks for wanting to help. Please read this page before you write code — it will save you a rejected pull request.

## Table of Contents

- [Contribution policy](#contribution-policy)
- [Prerequisites](#prerequisites)
- [First-time setup](#first-time-setup)
- [Running the desktop app](#running-the-desktop-app)
- [Running Pragma Go (mobile and web)](#running-pragma-go-mobile-and-web)
- [Running the website and docs](#running-the-website-and-docs)
- [Built-in Pragma scripts](#built-in-pragma-scripts)
- [Repository tour](#repository-tour)
- [Where things go](#where-things-go)
- [Style guidelines](#style-guidelines)
- [Testing](#testing)
- [Quality gates](#quality-gates)
- [Working with coding agents](#working-with-coding-agents)
- [Commit style](#commit-style)
- [Opening a pull request](#opening-a-pull-request)

## Contribution policy

**We only accept small features.** Bug fixes and other small, focused changes are by far the most likely to be merged.

- **Bug fixes** — very welcome. Open one for anything reproducible.
- **Small features** — welcome, but open an issue first and get a maintainer to agree on the shape before you build it.
- **Large features, rewrites, and sweeping refactors** — will almost certainly be declined, no matter how good the code is. Pragma's architecture is still moving, and a big unsolicited pull request is expensive to review and usually conflicts with work already in flight.
- **Drive-by dependency bumps, formatting-only churn, and README rewrites** — declined unless they fix a real problem.

Rules of thumb: one concern per pull request.

Everything starts in the [issue tracker](https://github.com/pragma-sh/pragma/issues).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.3.14 or newer | Package manager and task runner. npm/yarn/pnpm are not supported. |
| [Rust](https://www.rust-lang.org/tools/install) | current stable, with `clippy` and `rustfmt` | Keep it current — CI clippy runs newer lints than a stale local stable. |
| [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) | per platform | Linux additionally needs the GTK/WebKit packages plus `libpipewire-0.3-dev`, `libgbm-dev`, and `libclang-dev` (see the `rust`/`build` jobs in CI for the exact list). Windows needs nothing extra — WebView2 ships with the OS. |
| [Xcode](https://developer.apple.com/xcode/) / [Android Studio](https://developer.android.com/studio) | latest | Only if you work on Pragma Go. |

Platform floor for running the app: macOS, Linux, or Windows 10 version 1809 (build 17763) — ConPTY sets that floor and the server panics below it.

## First-time setup

```bash
git clone https://github.com/pragma-sh/pragma.git
cd pragma
bun install
```

`bun install` also installs the Husky git hooks. The root `bunfig.toml` pins `linker = "hoisted"` — leave it alone, Metro and Babel in Pragma Go break under the default isolated linker.

Generated code is not committed. If TypeScript complains about missing `src/generated/**` modules, run:

```bash
bun run generate     # regenerate shared constants for TS and Rust
```

## Running the desktop app

```bash
bun run dev          # same as: bun run dev:pragma
```

That one command does more than it looks like. `tauri:dev` builds the dev-test plugin, stages the `pragma-server` sidecar, stages the Pragma Go web bundle, and then starts Tauri with `src-tauri/tauri.dev.conf.json` — a separate "Pragma Dev" identity, so a dev build and an installed release can run side by side without sharing state.

Useful variations:

```bash
bun run --filter pragma tauri:build       # full desktop bundle for your platform
bun run --filter pragma sidecar:server    # restage the server sidecar only
bun run --filter pragma plugins:refresh   # restage the bundled plugins
PRAGMA_SKIP_WEB=1 bun run dev             # skip the Expo web export
bun run dev:command -- <dev-id> "<cmd>"   # open a command in a new tab of a running dev build
bun run benchmark                         # terminal lag benchmark (drives its own dev window)
```

You can also run the pieces directly when debugging:

```bash
cargo run -p pragma-server
cargo run -p pragma-gateway -- --socket /path/to/daemon.sock
cargo run -p pragma-cli -- agent report --agent dev started
```

## Running Pragma Go (mobile and web)

`apps/pragma-go` is one Expo (SDK 57) source tree that builds for iOS, Android, **and**the browser. Anything a browser cannot do lives behind a `*.web.ts(x)` twin, never a `Platform.OS === "web"` branch inside a screen.

```bash
bun run dev:go:ios       # first run: build the dev client + boot the iOS simulator
bun run dev:go:android   # first run: build the dev client + boot the Android emulator
bun run dev:go           # Metro dev server, once the dev client is installed
bun run --filter pragma-go web   # Metro dev server for the browser build
```

The app is useless until it is **paired** with a running desktop: it talks to the host's local HTTP gateway through `@pragma/sdk`, and without a verified connection `app/pair.tsx`replaces the whole app. Pair by QR from the desktop's pairing panel, or set `EXPO_PUBLIC_PRAGMA_GATEWAY_URL` and `EXPO_PUBLIC_PRAGMA_GATEWAY_TOKEN` for development.

For the browser build the desktop serves a staged export, not a dev server:

```bash
bun run --filter pragma web:stage   # export Expo web into apps/pragma/src-tauri/resources/web/
```

The gateway serves that bundle from a generated `manifest.json` by key lookup — request paths are never joined onto a filesystem path — under the `/web` base path. `/web` is deliberately unauthenticated (a `<script src>` cannot carry a bearer token); every `/v1`route stays behind the token.

If pairing fails with "couldn't reach the desktop" while tunnelling through ngrok's free tier, that is the HTML interstitial — the client already sends `ngrok-skip-browser-warning`, so check that your request path goes through `clientFor()`.

## Running the website and docs

```bash
bun run dev:www      # Next.js + Fumadocs on http://localhost:3000
```

Docs content is MDX under `apps/www/content/docs/`. See `apps/www/AGENTS.md`.

## Built-in Pragma scripts

If you develop Pragma **inside** Pragma, the repo ships `.pragma/scripts.json`, which is the project lifecycle-script file Pragma reads for every project. It has three keys, all optional:

```jsonc
{
  // Headless commands run once, from a freshly created worktree's root.
  "setup": ["bun install"],

  // Interactive scripts that open terminal tabs from the workspace header.
  "runScripts": {
    "run": { "command": ["bun run dev"] },
    "build": { "command": ["bun run --filter pragma tauri:build"] },
    "www": { "command": ["bun run dev:www"], "icon": "lucide:globe" },
  },

  // Headless commands run before a worktree is deleted. A failure blocks deletion.
  "teardown": [],
}
```

- `run` and `build` are the two keys the header always reserves buttons for. Any other key renders its own button, using the Iconify name in `icon` (or a generic terminal icon).
- A `command` entry is either a command string or a split-layout node — `{ "left": …, "right": … }` or `{ "top": …, "bottom": … }`, nestable — so one button can open a whole pane layout.
- `setup` and `teardown` are headless and bounded by `constants.scripts.maxConcurrentCommands`; interactive run scripts create real tabs and are not bounded by it.
- The file is watched, so editing it hot-reloads the header buttons.

Also in `.pragma/`: `config.json` (project settings, `plugins[]`), `theme.json` (colour token overrides), and `automations/` (TypeScript files run by the `pragma-automations`sidecar — `hello-cron.ts` and `watch-build.ts` are working examples).

## Repository tour

```
apps/
  pragma/       Tauri v2 desktop app — React 19 + Vite frontend, Rust in src-tauri/
  pragma-go/    Expo SDK 57 client — iOS, Android, and web from one tree
  www/          Next.js marketing site + Fumadocs documentation
crates/
  pragma-server/    Persistent host server: PTY and session ownership, over a local socket
  pragma-client/    Native client frame I/O, SSH bridge, WSL bridge
  pragma-core/      Host business logic boundary (git, fs, fanout rules)
  pragma-gateway/   Localhost HTTP gateway — what mobile and web talk to
  pragma-protocol/  Shared wire frames
  pragma-platform/  Every OS difference: ipc, path, perms, process, shell
  pragma-cli/       `pragma-cli` — agent status reporting and scripting
packages/
  constants/        Dual TS + Rust shared constants (schema.json + values.json)
  sdk/              `@pragma/sdk` — typed Node/Bun wrapper over the gateway
  plugin/           `@pragma/plugin` — public plugin API
  automations/      `@pragma/automations` — authoring API + host sidecar
  scratchpad*/      Scratchpad runtime, file contract, and read-only viewer
  *-plugin/         Agent integrations: claude-code, codex, cursor, opencode, pi, grok, …
  …                 brand, bench, sidecar-kit, github-helpers, ai-helpers, plugins-host
skills/             Canonical user-facing agent skills, symlinked into .agents/skills
```

Architecturally: `pragma-server` owns sessions; `pragma-gateway` translates HTTP to the protocol; native clients speak frames over a local Unix socket (on all three platforms), or over a bridge presenting an SSH host or WSL distribution as one; agent plugins report status through `pragma-cli`.

Every app, crate, and package has its own `AGENTS.md`. **Read the relevant one before touching that area** — this file is a summary, those are the source of truth. The root `AGENTS.md` (to which `CLAUDE.md` is a symlink) holds the repo-wide rules.

## Where things go

The overriding priority is a clean, reusable architecture with consistent rules across TypeScript and Rust. Reuse before you write; lift duplicated logic the moment it appears twice; do not be afraid to create a new package.

| What | Where |
| --- | --- |
| A value used by both frontend and backend | `packages/constants` (`values.json`) — never hand-copied across the boundary |
| A value or helper shared by frontend modules | `apps/pragma/src/lib/` |
| Anything that calls the Rust backend | `apps/pragma/src/lib/tauri.ts` — never `invoke()` from a component |
| GitHub REST/GraphQL | `apps/pragma/src/lib/github.ts` — never a second Octokit |
| A reusable UI primitive | `apps/pragma/src/components/ui/` (prefer `shadcn add`) |
| Anything that differs between operating systems | `crates/pragma-platform` — never a bare `#[cfg(unix)]` at the call site |
| A helper that a future app could reuse | a new `packages/*` |

Three platform reflexes that are visible bugs on Windows if you get them wrong: use `pragma_platform::path::canonicalize` (not `std::fs`'s, which returns `\\?\C:\…`); spawn with `pragma_platform::process::command` (not a bare `Command::new`, which pops a console window); and name executables with `pragma_client::executable_name` (not a bare string, which misses `.exe`). Compare paths with `Path`, never `String`.

## Style guidelines

Formatting is automated and non-negotiable — **oxfmt** for TypeScript, **rustfmt** for Rust, both auto-applied on commit and enforced in CI. Do not argue with the formatter.

| Concept | TypeScript | Rust |
| --- | --- | --- |
| Variables / functions | `camelCase` | `snake_case` |
| Types / components | `PascalCase` | `PascalCase` |
| Constants | `UPPER_SNAKE` (true consts), `camelCase` objects | `UPPER_SNAKE` |
| Files | `kebab-case.ts`, `PascalCase.tsx` for components | `snake_case.rs` |
| Wire JSON keys | `camelCase` | `camelCase` on the wire, `snake_case` fields via serde rename |

- **Strictness is on everywhere.** TS runs `strict` with `noUncheckedIndexedAccess` and `noUnusedLocals`/`noUnusedParameters`; Rust runs clippy `all` + `pedantic` as `-D warnings` with `unsafe_code = "forbid"`. Never silence a lint without a comment saying why.
- **Errors are values, surfaced explicitly.** TS: throw or return typed errors, narrow with `instanceof`, never swallow. Rust: return `Result` and use `?`; reserve `expect`/`panic!` for genuinely unrecoverable startup invariants.
- **No magic values.** Cross-boundary values live in `@pragma/constants`.
- **One responsibility per file/module.** Imports are grouped: external deps, then workspace packages, then relative.
- **Public items are documented** — a JSDoc line on exported TS, a `///` comment on public Rust.
- **Keep the IPC surface typed and centralized.** Every Tauri command has a matching wrapper in `src/lib/tauri.ts` and a `#[tauri::command]` of the same name.

## Testing

Add a test with every behaviour change. Keep them fast and deterministic.

```bash
bun run test         # Vitest across packages
bun run rust:test    # cargo test --workspace
```

TypeScript tests are co-located `*.test.ts(x)`; frontend tests run under jsdom and mock the Tauri API rather than the native shell. Rust tests are `#[cfg(test)] mod tests` next to the code.

A test must pass on macOS, Linux, **and** Windows. Recurring traps: `git init` in a fixture inherits Git for Windows' `core.autocrlf=true`, so pin `core.autocrlf=false` and `core.eol=lf` in the fixture repo; build `PATH` fixtures with `std::env::join_paths`, not a literal `"/a:/b"`; never assert on shell output like `pwd`, which prints an MSYS path under Git Bash; and never let a `#[cfg(unix)]`-only setup step leave a vacuously passing test on Windows.

Never add a `pretest` hook that builds the package — `test` already depends on `build` in `turbo.json`, and the two bundlers race for the same `dist/`.

## Quality gates

Run before you push:

```bash
bun run check        # oxlint + oxfmt --check + typecheck + cargo fmt --check + clippy
bun run test
bun run rust:test
```

Individual pieces: `bun run lint`, `bun run lint:fix`, `bun run format`, `bun run typecheck`, `bun run rust:fmt`, `bun run rust:clippy`, and `bun run fallow:check`(dead code, duplication, and complexity, gated to what your branch introduces).

Git hooks do some of this for you:

- **pre-commit** — `lint-staged` auto-fixes staged files (`oxlint --fix`, `oxfmt --write`, `rustfmt`).
- **commit-msg** — commitlint validates the message.
- **pre-push** — typecheck, `cargo fmt --check`, sidecar staging, `cargo check`, and `fallow:check`.

CI re-verifies everything in check mode and never auto-fixes. It is split by platform: [RWX](https://www.rwx.com) runs everything Linux can run (`.rwx/ci.yml`), and GitHub Actions runs the macOS and Windows builds plus the Windows Rust suite (`.github/workflows/ci.yml`). **Adding or removing a check means editing both files.**

## Working with coding agents

Pragma is built with coding agents, and the repo is set up for them:

- `AGENTS.md` **is the contract.** The root file holds repo-wide rules; every app, crate, and package has its own with the specifics. `CLAUDE.md` is a symlink to the root one, so both audiences stay in sync. Point your agent at the `AGENTS.md` closest to the code it is touching.
- **The guide is living — fix it in the same change.** If your change makes an `AGENTS.md`stale (you added a package, moved a file, changed a command, adopted a pattern), update it in the same commit. That is expected, not optional. When you learn a gotcha the hard way, write it down there so nobody rediscovers it.
- **Mirror workflow changes into the skills.** User-facing skills live in `skills/` and are symlinked into `.agents/skills/` (which `.claude/skills` also exposes); internal contributor skills live directly in `.agents/skills/`. Relevant ones: `pragma-architecture` (where code goes), `shared-constants`, `tauri-command`, `code-quality`, `pragma-go`, and `pragma`.
- **Run agents in worktrees.** That is what Pragma is for — one agent per worktree, no collisions. Note that a Pragma worktree can be a partial checkout; if `cargo` or Vitest fails on a missing root `Cargo.toml` or `tsconfig.base.json`, that is why.
- **Manually test changes.** Always make sure you test your changes. You do not have to read every line of code just make sure the changes work.
- **Do not let an agent widen the scope.** The [contribution policy ](#contribution-policy)applies to agent-written code exactly as it does to hand-written code — an agent that helpfully refactors four extra packages has just made your pull request unmergeable.
- **Do not commit generated files or agent scratch output** (`src/generated/**`, scratchpads, transcripts).

## Commit style

[Conventional Commits](https://www.conventionalcommits.org), enforced by commitlint locally and in CI:

```
<type>(<scope>): <subject>
```

- **types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scope:** optional; prefer a package, app, or crate name (`pragma`, `pragma-go`, `constants`, `sdk`, `www`, `ci`, `deps`)
- **subject:** imperative mood, lower case, no trailing period

```
feat(pragma): add settings window
fix(constants): correct minimum window width
docs(www): document the plugin manifest fields
```

Releases are cut by Release Please from these messages, so the type and scope you choose end up in the changelog. A breaking change needs a `!` after the scope and a `BREAKING CHANGE:` footer.

## Opening a pull request

1. **Open an issue first** for anything that is not a small, obvious bug fix, and wait for a maintainer to agree on the approach.
2. **Branch off** `main`**.** Name it however you like.
3. **Keep the diff focused.** One concern per pull request. Split unrelated changes.
4. **Add tests** for behaviour changes, and **update the relevant** `AGENTS.md` in the same commit if your change makes it stale.
5. **Run the gates** — `bun run check`, `bun run test`, `bun run rust:test` — and make sure they pass locally before you push.
6. **Write the pull-request body for a reviewer**: what changed, why, how you verified it, and screenshots or a short clip for anything visual. Link the issue with `Closes #123`.
7. **Say which platforms you tested on.** CI covers macOS, Linux, and Windows; tell us which one you actually ran the app on.
8. **Expect review.** Push follow-up commits rather than force-pushing over the history a reviewer is reading; we squash on merge.

By contributing you agree that your contribution is licensed under the [GNU Affero General Public License v3.0](./LICENSE).