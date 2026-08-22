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
  `shared-constants`, `tauri-command`, `code-quality`, `agent-plugin`) too, and
  add a new skill when you add a substantial new workflow.
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
| PDF viewing       | [EmbedPDF](https://www.embedpdf.com) headless React plugins + the `@embedpdf/pdfium` wasm, bundled locally (never CDN-fetched)                                  |
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
| CI                | [RWX](https://www.rwx.com) for Linux (`.rwx/ci.yml`) + GitHub Actions for macOS/Windows (`.github/workflows/ci.yml`)                                            |
| Code intelligence | [fallow](https://fallow.tools) — dead-code / duplication / complexity audit (TS/JS only); config in `.fallowrc.jsonc`                                           |

## Repository structure

```
.
├── apps/
│   ├── pragma/                  # Tauri desktop app → see apps/pragma/AGENTS.md
│   ├── pragma-go/               # Expo (SDK 57) client: iOS, Android, and web → see apps/pragma-go/AGENTS.md
│   └── www/                     # Next.js marketing + docs site → see apps/www/AGENTS.md
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
│   ├── bench/                   # Dual TS + Rust terminal lag benchmark (`pragma-bench`) → see packages/bench/AGENTS.md
│   ├── sdk/                     # `@pragma/sdk` Node/Bun wrapper → see packages/sdk/AGENTS.md
│   ├── scratchpad/              # interactive MDX scratchpad runtime/UI → see packages/scratchpad/AGENTS.md
│   ├── scratchpad-contract/     # scratchpad file contract: managed frontmatter + comment threads → see packages/scratchpad-contract/AGENTS.md
│   ├── scratchpad-viewer/       # read-only scratchpad web-view document → see packages/scratchpad-viewer/AGENTS.md
│   ├── plugin/                  # `@pragma/plugin` public plugin API/runtime stub → see packages/plugin/AGENTS.md
│   ├── plugin-registry/         # official npm list + generated manifest lock → see packages/plugin-registry/AGENTS.md
│   ├── automations/             # `@pragma/automations` authoring API + sidecar runner → see packages/automations/AGENTS.md
│   ├── create-pragma-plugin/    # Plugin scaffolder CLI → see packages/create-pragma-plugin/AGENTS.md
│   ├── github-helpers/          # `pragma-github` sidecar → see packages/github-helpers/AGENTS.md
│   ├── sidecar-kit/             # `@pragma/sidecar-kit` shared NDJSON stdin helpers for host sidecars → see packages/sidecar-kit/AGENTS.md
│   ├── opencode-plugin/         # opencode integration → see packages/opencode-plugin/AGENTS.md
│   ├── claude-code-plugin/      # Claude Code integration → see packages/claude-code-plugin/AGENTS.md
│   ├── cursor-plugin/           # Cursor Agent CLI integration → see packages/cursor-plugin/AGENTS.md
│   ├── codex-plugin/            # OpenAI Codex CLI integration → see packages/codex-plugin/AGENTS.md
│   ├── pi-plugin/               # Pi CLI integration → see packages/pi-plugin/AGENTS.md
│   ├── prime-agent-plugin/      # Prime Agent integration → see packages/prime-agent-plugin/AGENTS.md
│   ├── grok-plugin/             # xAI Grok Build CLI integration → see packages/grok-plugin/AGENTS.md
│   ├── kimi-plugin/             # Kimi Code CLI integration → see packages/kimi-plugin/AGENTS.md
│   ├── junie-plugin/            # JetBrains Junie CLI integration → see packages/junie-plugin/AGENTS.md
│   ├── github-copilot-cli-plugin/ # GitHub Copilot CLI integration → see packages/github-copilot-cli-plugin/AGENTS.md
│   ├── plugins-host/            # `@pragma/plugins-host` plugin catalog sidecar (`pragma-plugins`) → see packages/plugins-host/AGENTS.md
│   └── dev-test-plugin/         # `@pragma/dev-test-plugin` sample plugin (sidebar tabs/cards + web view + SDK event hook) → see packages/dev-test-plugin/AGENTS.md
│   ├── constants/               # Dual TS + Rust package — shared source of truth
│   ├── sdk/                     # `@pragma/sdk` typed Node/Bun wrapper around `pragma-cli`
│   ├── automations/             # `@pragma/automations` API + `pragma-automations` host sidecar
│   ├── ai-helpers/              # `@pragma/ai-helpers` — wraps the pi coding-agent SDK (auth, pickModel, prompts); `src/cli.ts` is the `pragma-ai` sidecar
│   ├── github-helpers/          # `@pragma/github-helpers` — Octokit host sidecar; `src/cli.ts` is `pragma-github`
│   ├── opencode-plugin/         # `@pragma-sh/opencode-plugin` ESM opencode status plugin
│   └── plugins-host/            # `@pragma/plugins-host` — `pragma-plugins` host sidecar (agent catalog + icon assets)
├── skills/                       # Canonical first-party skill sources; symlinked into `.agents/skills`
├── tsconfig.base.json           # Shared strict TS config (every package extends it)
├── Cargo.toml                   # Rust workspace (shared deps + lints + release profile)
├── rustfmt.toml                 # Rust formatting rules
├── turbo.json                   # Task graph
├── commitlint.config.js         # Conventional Commits rules
├── .oxlintrc.json / .oxfmtrc.json
├── .rwx/                        # RWX run definitions (Linux CI)
├── .husky/                      # Git hooks
└── .agents/skills/              # Installed skill view (also exposed through .claude/skills)
```

**Where things go:**

- User-tunable global settings live in `~/.pragma/config.json` (plugins under `plugins[]`,
  remote-access tunnel under `tunnel` = `{ command, urlPattern }`, agent alerts under
  `agentStatus` = `{ notificationsEnabled, soundName }`, the "Created with Pragma"
  pull-request footer under `github` = `{ prSignature }`, desktop auto-update overrides
  under `updates` = `{ checkUrl, autoDownload }`). Keyboard shortcuts are separate:
  `~/.pragma/keybindings.json`, overridable per project. Shipped defaults for such settings
  belong in `@pragma/constants` (e.g. `tunnel.defaultCommand`, `agentStatus.*`, `updates.*`)
  so Rust and TS agree, never hard-coded in one language.
- Desktop Settings is a full-frame UI wrapper over global/project `.pragma/config.json`
  and `keybindings.json`; native `Cmd+,` opens it on macOS. Plugins, Keybindings, Themes,
  and Agent Status have both a global and a project scope (project wins); GitHub, AI,
  Other (update server/download), and mobile pairing/gateway history are global-only.
- Color overrides live in a separate optional `.pragma/theme.json`, global and per project,
  merged `index.css` defaults <- global <- project. Never restate a shipped default color in
  TS or Rust: `apps/pragma/src/index.css` is the source of truth and the token catalog is
  parsed from it. Sourced built-in palettes live in `apps/pragma/src/lib/theme-presets.ts`.
  See _User themes_ in `apps/pragma/AGENTS.md`.
- Agent alert clips live in `.pragma/assets/sounds` (home directory for global clips,
  project root for project clips) and are read through the owning host, so a remote
  project's clips work the same as a local one's.
- The pull-request footer is text-only — a heading, a tagline, a small "Open worktree"
  link, and the opt-out line. It references **no** hosted image: a raw URL on `main` would
  be a published contract baked into other people's repositories. Keep it that way.
- A value used by both frontend and backend → `packages/constants` (`values.json`).
- A value/helper used by multiple frontend modules → `apps/pragma/src/lib/`.
- A helper/type that could be reused by a future app → a new `packages/*` package.
- A typed JS wrapper over the bundled Pragma CLI → `packages/sdk` (`@pragma/sdk`).
- Agent-authored scratchpad runtime and UI components → `packages/scratchpad` (`@pragma/scratchpad`).
- The scratchpad **file contract** (managed frontmatter, agent attachment, the
  sibling comment-thread file) → `packages/scratchpad-contract`
  (`@pragma/scratchpad-contract`); the read-only web-view renderer native clients
  embed → `packages/scratchpad-viewer` (`@pragma/scratchpad-viewer`), which
  re-exports the contract. The desktop, the SDK, and the mobile client all import
  it — do not re-implement frontmatter parsing or comment serialization.
- Anything a client does _with_ a scratchpad over the gateway (comment on one,
  attach an agent, prompt the attached agent) → `client.scratchpads` in
  `packages/sdk`, not a per-client reimplementation.
- Public APIs for pure TypeScript Pragma plugins → `packages/plugin` (`@pragma/plugin`).
- Plugin templates/scaffolding → `packages/create-pragma-plugin`.
- A pure-TS sample/exercise plugin (sidebar tab, sidebar card, web view, SDK event hook) →
  `packages/dev-test-plugin` (`@pragma/dev-test-plugin`).
- Fanout orchestration (one prompt into several isolated attempts, then keeping
  one) lives on the host: the durable record and the state machine in
  `crates/pragma-server/src/fanouts.rs`, the side effects behind its
  `FanoutHost` seam in `crates/pragma-server/src/fanout_host.rs`, and the pure
  rules (selector resolution, branch naming, status roll-up, scratchpad
  promotion naming) in `crates/pragma-core/src/fanout.rs`. The CLI
  (`pragma-cli fanout`), the SDK (`client.fanouts`), and the desktop are three
  callers of the same `fanouts` RPC — never a second implementation.
- Anything that measures perceived terminal latency → `packages/bench`
  (`bun run benchmark`). It drives a real dev window; do not add a headless
  variant that claims to measure rendering.
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
bun run dev:pragma         # Same as `bun run dev`, named explicitly
bun run dev:www            # Run the marketing + docs site (Next.js, http://localhost:3000)
bun run dev:command -- <dev-id> "<command>" # Open command in a new terminal tab in that dev build
bun run --filter pragma tauri:build   # Build the desktop app (macOS/Linux/Windows bundles)
bun run benchmark          # Terminal lag benchmark: launches its own dev instance → see packages/bench/AGENTS.md

# Pragma Go (Expo, apps/pragma-go) — see apps/pragma-go/AGENTS.md
bun run dev:go:ios         # First run: build dev client + boot iOS simulator
bun run dev:go:android     # First run: build dev client + boot Android emulator
bun run dev:go             # Metro dev server (after the dev client is installed once)
bun run --filter pragma-go web           # Metro dev server for the browser build
bun run --filter pragma web:stage        # Export + stage the web bundle into the desktop resources

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
bun run check              # Lint + format/type checks + rustfmt/clippy (tests run separately)

bun run generate           # Regenerate shared-constant types from schema/values
bun run plugins:lock:local # Build/pack official workspace plugins and refresh local test lock
bun run plugins:lock       # Refresh lock from exact published npm releases
cargo run -p pragma-server # Run the persistent server directly for debugging
cargo run -p pragma-gateway -- --socket /path/to/daemon.sock # Run the localhost HTTP gateway
cargo run -p pragma-cli -- agent report --agent dev started # Manually send an agent report (inside a Pragma terminal env)
cargo run -p pragma-cli -- fanout create "Add token refresh" --agent opencode --agent claude-code # Fan one prompt into two isolated attempts
```

## Pragma Go on the web

`apps/pragma-go` builds for iOS, Android, **and** the browser from one source
tree. The browser build is served by `pragma-gateway` under
`constants.gateway.web.basePath` (`/web`), so a user who has the tunnel URL can
open the client without installing anything.

- **One app, platform extensions.** Anything a browser cannot do lives behind a
  `*.web.ts(x)` twin, never a `Platform.OS === "web"` branch scattered through a
  screen: `secret-store` (keychain vs Web Storage), `gateway-fetch`
  (`expo/fetch` vs the platform `fetch`), `GlassSurface`, `IconSymbol`
  (SF Symbols vs Lucide), `ui/menu-view`, `ScratchpadWebView` (native web view
  vs sandboxed `<iframe>`), and `use-widget-sync`. A `.web` twin also keeps
  native-only module graphs — `@expo/ui/swift-ui`, `react-native-webview` — out
  of the web bundle entirely.
- **The bundle is a Tauri resource, not bytes in a binary.** `web:stage` runs
  the Expo export and writes `apps/pragma/src-tauri/resources/web/`. Keeping it
  out of `pragma-gateway` means a web-only change never triggers a Rust
  rebuild. Set `PRAGMA_SKIP_WEB=1` to skip the export in a build that does not
  need it.
- **The gateway serves a manifest, never a directory.** `stage-web-bundle.ts`
  emits `manifest.json`; the gateway loads it into a map and answers each
  request by **key lookup**. A request path is never joined onto a filesystem
  path, so traversal is not expressible rather than merely blocked. Text assets
  are stored gzip-only and served that way; the entry point answers any
  unmatched non-file path so client-side routes work on reload.
- **`/web` is deliberately unauthenticated**, because a browser cannot attach a
  bearer token to a `<script src>`. The bundle is public code; every `/v1`
  route stays behind the token. The desktop's pairing panel offers a link with
  the token in the URL **fragment**, which is never sent to a server — the app
  consumes it on load and strips it from the address bar.
- **Wide layouts.** iPadOS gets the system sidebar for free via
  `NativeTabs sidebarAdaptable`. Web and Android tablets use the shared
  `AppSidebar`, swapped in for the tab bar above `WIDE_LAYOUT_BREAKPOINT`. Only
  the bar is exchanged, not the navigator, so resizing never resets navigation.

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
compile-only Tauri build on macOS, Linux, **and** Windows.

**CI is split across two providers, by platform.** [RWX](https://www.rwx.com) runs
Linux containers only — `rwx/base` supports the `ubuntu:*` images and nothing else, and
runners are x86_64/arm64 Linux — so everything that can run on Linux (commitlint, the
TypeScript checks, the Rust checks, the fallow audit, the Linux app build) lives in
`.rwx/ci.yml`, and the
macOS and Windows builds plus the Windows Rust suite stay in
`.github/workflows/ci.yml`. **Adding or removing a check means touching both files.**
RWX is a task DAG, not a job list: tasks with no `use:` run in parallel, caching is
content-based (no cache actions — add a `filter:` to keep a task's cache key off files
it doesn't read), and the default task timeout is **10 minutes**, so any long task needs
an explicit `timeout:`. Iterate without pushing via `rwx run .rwx/ci.yml --wait`, and
validate edits with `rwx lint .rwx/ci.yml`; both need `rwx login` first.

The **fallow** audit is an RWX task (`fallow` in `.rwx/ci.yml`), not a GitHub Action —
there is no `fallow-rs/fallow` RWX package, so it runs the CLI directly. It scopes to the
diff against the base ref and fails on issues the change introduces. The sticky PR summary
comment is posted by the task itself: `--format pr-comment-github` prefixes the body with
`<!-- fallow-id: fallow-results -->`, and the task matches that marker to update the
existing comment instead of adding one per run. **Inline annotations are not reproduced** —
they came from the action's SARIF upload; the findings live in the task log and the
comment. The task needs `code-with-history` (fallow diffs against a real base) _and_
`generate` (fallow resolves imports statically, so the gitignored `src/generated/**`
modules must exist first).

**CI clones and fetches with no token — `pragma-sh/pragma` is public.** RWX's
`${{ github.token }}` context is not to be relied on: it can vanish mid-run with
`The context key "github" is not available in this expression`, and it could never write
to a PR anyway — the GitHub App installation token is scoped to reading repository
contents, with no `pull_requests` or `issues` permission, so any `gh` call against them
dies with `Resource not accessible by integration (HTTP 403)` — which is how the fallow
comment silently stopped appearing while the task still exited 0. Anything that writes to
GitHub needs its own credential from the RWX default vault: fallow reads
`${{ secrets.fallow-comment-token }}` into `GH_TOKEN` (a fine-grained token with
**Pull requests: read and write** on `pragma-sh/pragma`). Set or rotate it with
`rwx vaults secrets set --vault default fallow-comment-token=<token>`; a run started before
the secret exists fails to resolve the expression, so add the secret before merging a change
that references a new one.

## Platform targets

We target **macOS, Linux, and Windows**. `tauri.conf.json` bundles `app`/`dmg` (macOS),
`deb`/`rpm`/`appimage` (Linux), and `msi`/`nsis` (Windows). Don't add Android specifics
without updating this guide and CI.

- **Linux** builds need the GTK/WebKit system libraries — see the `rust`/`build` jobs in
  CI for the exact `apt` list. `xcap` pulls in `libspa-sys` (`libpipewire-0.3-dev`),
  `libgbm-dev`, and `libclang-dev` — all required at link time and must stay in that list.
- **Windows** needs no system packages: the webview is WebView2, which ships with the OS
  on Windows 11 and with the Edge runtime on Windows 10. CI covers it on the
  GitHub-hosted `windows-latest` image with the `rust-windows` job plus a
  `windows-latest` entry in the `build` matrix.
- **The per-user NSIS installer has to stop the sidecars, not just the app.** Windows
  locks a running executable's image, our sidecars outlive the window by design, and a
  per-user NSIS install puts them in `%LOCALAPPDATA%\Pragma` — so reinstalling over a live
  instance dies with `Error opening file for writing:
…\AppData\Local\Pragma\pragma-server.exe`. `installer-hooks.nsh` handles this and stays
  keyed to `bundle.externalBin`. The elevated per-machine MSI deliberately relies on
  Windows Installer Restart Manager instead: WiX `util:CloseApplication` matches only by
  executable basename and could otherwise terminate another user's or unrelated process.
  See `apps/pragma/AGENTS.md`.
- **Never spell a shell script's runner as bare `bash` in a package script.** On Windows
  with WSL installed, `bash` on `PATH` is `C:\Windows\system32\bash.exe` — the WSL
  launcher — whose Linux `PATH` has no `rustc`, `cargo`, or `bun`, so the sidecar staging
  dies with `rustc: command not found` (exit 127). CI's `windows-latest` image ships no
  WSL, so this never fires there and only breaks developer machines. Go through
  `scripts/run-shell-script.ts`, which derives Git Bash from the resolved `git.exe`
  (override with `PRAGMA_BASH`) and is a plain `bash` everywhere else.
- **Line endings are pinned by `.gitattributes`.** The build shells out to
  `src-tauri/scripts/*.sh` through Git Bash, and Git for Windows checks files out as CRLF
  by default. A `\r` on the `set -euo pipefail` line fails the build with
  `set: pipefail: invalid option name` (the `\r` hides itself by wrapping the cursor).
  `*.sh` and the Husky hooks are therefore forced to `eol=lf`. After pulling a change to
  `.gitattributes`, an existing Windows checkout still holds the old CRLF files — refresh
  it with `git rm --cached -r . && git reset --hard` (commit or stash first: that command
  discards uncommitted work).
- **A Windows checkout has no real symlinks — `core.symlinks=false`.** Git writes each
  one as a small text file holding its target path, so `CLAUDE.md` is literally the nine
  bytes `AGENTS.md`. Any formatter that matches it will "fix" it (oxfmt appends a trailing
  newline) and the symlink is then broken for everyone on macOS/Linux. `CLAUDE.md` is in
  `.oxfmtrc.json`'s `ignorePatterns` for exactly this reason; the other tracked symlinks
  (`.claude/skills`, `.agents/skills/*`) are extension-less and no formatter claims them.
  If you add a symlink whose name a formatter or linter would match, ignore it there too.
- **The whole tree is `eol=lf`, not just `*.sh`.** Every blob here is already LF; the
  hazard is `text=auto` **alone**, which lets `core.autocrlf=true` write CRLF into a
  Windows working tree. oxfmt enforces LF, so `bun run format:check` (and thus
  `bun run check`) fails on _every_ file on Windows while CI stays green — Linux/macOS
  check out LF regardless. Diagnose this by byte count, not `grep '\r'`: MSYS `grep -U`
  reports CRs inconsistently under Git Bash. Compare `git cat-file -s HEAD:<file>` with
  the on-disk size — a positive difference equal to the line count means the worktree is
  CRLF while the blob is LF.

**Minimum Windows version: 10 version 1809 (build 17763), October 2018.** ConPTY sets
that floor, and it is a hard one — `portable-pty` resolves `CreatePseudoConsole` from
`kernel32.dll` and `expect`s it, so on an older build the server _panics_ (and release
builds are `panic = "abort"`) the first time a terminal opens. The `AF_UNIX` transport
needs only 1803, so it is not the binding constraint. Opening a **WSL** session needs
1903 (18362) or later, because that is when `wsl.exe --list --verbose` and WSL2 arrived;
PowerShell sessions have no such requirement. Nothing checks any of this at startup, so
a user below the floor gets a panic rather than a message naming the reason; if that
becomes a real support burden, the place to fix it is a probe in `pragma-platform`.

**Never add a `#[cfg(unix)]` block with a silently-empty `#[cfg(not(unix))]` twin.** That
pattern is how a security guarantee quietly disappears — it is exactly what let the
GitHub token be written world-readable on Windows. Platform differences belong in
`crates/pragma-platform`, which owns five seams and has a real implementation for each
on every target:

| Seam      | What it owns                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| `ipc`     | The local socket: `AF_UNIX` everywhere, `uds_windows` on Windows             |
| `path`    | Canonical paths external programs accept (no Windows `\\?\` verbatim prefix) |
| `perms`   | Owner-only files/dirs: `0600`/`0700` on Unix, an `icacls` ACL on Windows     |
| `process` | Kill, kill-tree, liveness, the process table, and windowless child spawning  |
| `shell`   | Which shell a PTY launches, and its interactive arguments                    |

Three of those are easy to bypass by reflex, and every bypass is a visible bug on Windows:

- **Canonicalize with `pragma_platform::path::canonicalize`, never `std::fs`'s.** `std`
  returns `\\?\C:\…`, which git reads as a UNC path and refuses.
- **Spawn with `pragma_platform::process::command` (or `process_env::command`, which
  wraps it), never a bare `Command::new`.** A console program started from a GUI process
  pops a console window on Windows unless `CREATE_NO_WINDOW` is set.
- **Name executables with `pragma_client::executable_name`, never a bare string.** It
  appends `EXE_SUFFIX`, so `pragma-cli` becomes `pragma-cli.exe` on Windows. This applies
  to a path you _write_ as much as one you read: `agent_cli` copied the helper to a
  suffix-less name, so the copy was both unreadable on the next launch and not executable
  by agents resolving it from `PATH` — startup logged only
  `failed to install pragma-cli: os error 2`.

Two more rules that are not seams but bite the same way:

- **A path is not a string.** Compare with `Path`, not `String`: `Path` treats `/` and `\`
  as equivalent separators on Windows, so `Path::new(a) == Path::new(b)` holds where
  `a == b` fails. Never assert on a `"dir/file"` suffix — build it with `join`. And test
  absolute paths with `Path::is_absolute`, never `starts_with('/')`, which misses every
  Windows form (`C:\…`, `\\?\C:\…`) — that check silently rejected absolute
  `plugins[].path` entries as unsupported npm specifiers.
- **Clear the read timeout on a long-lived stream.** `configure_stream` sets a 5s read
  timeout so a wedged server cannot hang startup, but a subscription is mostly idle:
  leave it on and every quiet 5s looks like a dropped connection, so the bridge warns and
  reconnects forever (`os error 10060` on Windows, `WouldBlock` on Unix). Call
  `set_read_timeout(None)` once the subscribe response arrives, as
  `pragma_client::open_event_stream` and the `agent_events` bridge do.

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

**The two WSL layers, and which one is built.** Selecting a WSL shell and serving a WSL
session are separate problems, and only the first is wired up today:

- **Shell selection (built).** A session can launch `wsl.exe -d <distro>` on the host's
  own ConPTY. The chosen shell travels as a `ShellProfile` (`@pragma/constants`) on the
  `Spawn` request, is resolved by `pragma_platform::shell::resolve_profile_launch`, and
  is persisted on the tab (`tabs.shell_backend` / `shell_distro`) so a respawn after a
  server restart returns to the same shell. The user picks it in the new-tab menu, or as
  a default under Settings → Terminal.
- **Host-level WSL (not built).** `start_wsl_bridge` exists in `pragma-client` but
  nothing calls it. Until it does, a WSL terminal is served by the _Windows_ server, so
  the `PRAGMA_*` environment the session exports names Windows paths that the Linux side
  cannot open — agent plugins running inside such a tab do not report status. Wiring
  that up means registering the distribution as a host (mirroring `ssh_host.rs`) rather
  than adding another shell.

A project selects its shell in `.pragma/config.json` under `terminal`: `shell` names the
native program, `backend`/`distro` choose the world it runs in, and `hiddenDistros`
trims the picker. Both Settings scopes are honoured — the project's file wins and the one
under the home directory is the global default behind it — and each field falls back
independently, so a project that pins only `shell` still inherits the global `backend`.
Defaults live in `@pragma/constants` under `platform` and `terminalDefaults`.

## Testing

- **TS:** Vitest. Co-locate `*.test.ts(x)` next to the code. Frontend tests run under
  jsdom (`src/test/setup.ts`); mock the Tauri API rather than the native shell.
- **Rust:** `#[cfg(test)] mod tests` next to the code; `cargo test --workspace`.
- Add a test with every behavior change. Keep tests fast and deterministic.
- **Never build a package from a `pretest` hook.** `test` depends on `build` in
  `turbo.json`, so a package's own bundle is already there. A `pretest` that
  runs `bun run build` races the turbo `build` task for the same package — two bundlers
  writing one `dist/`, and the loser reads a half-written file
  (`ENOENT: … dist/index.cjs`). It only fires when both land in the same wave, so it
  passes locally and fails in CI.
- **A test must pass on all three platforms, and CI only proves that for the ones it
  runs.** The `rust-windows` job runs the full suite, so a POSIX-only assumption is a red
  build, not a local curiosity. The recurring offenders:
  - **`git init` in a fixture inherits the host's config.** Git for Windows ships
    `core.autocrlf=true` system-wide, so checked-out fixtures come back CRLF and every
    `"…\n"` assertion fails. Pin `core.autocrlf=false` + `core.eol=lf` **in the repo**
    (see `init_repo` in `pragma-core/src/git.rs`) — `git -c` on the test's own commands is
    not enough, because the code under test runs its own `git checkout`/`pull`, which read
    only the repository config.
  - **`PATH` is `;`-separated on Windows.** Build fixtures with `std::env::join_paths`,
    never a literal `"/a:/b"`, or the whole list arrives as one opaque entry and the
    assertion fails for the wrong reason.
  - **Shell output is not portable.** `pwd` under Git Bash prints an MSYS path
    (`/c/Users/…`) that never equals the Win32 path `canonicalize` returns. Assert on
    something the shell cannot reformat — e.g. `cat` a marker file that only resolves from
    the intended cwd. Likewise, `stty` is unavailable in the Windows PowerShell shell;
    query `$Host.UI.RawUI.WindowSize` when a test needs the active PTY dimensions.
  - **A `#[cfg(unix)]`-only setup step leaves a vacuous test.** `fs::rejects_symlink_escape`
    created its symlink only on Unix, so on Windows it asserted against a link that was
    never there. Windows symlinks also need Developer Mode or admin — skip explicitly when
    creation fails rather than passing for the wrong reason.
