---
name: pragma-architecture
description: Use when deciding WHERE new code, values, types, or components should live in the Pragma monorepo, or when considering whether to create a new package/directory. Covers the repo map and the clean/reusable-architecture rules.
---

# Pragma architecture & placement rules

Pragma is a Bun + Turborepo monorepo. The guiding priority is a **clean, reusable
architecture** with **consistent conventions across TypeScript and Rust**.

## Repo map

- `apps/pragma/src/` — React 19 + TS frontend.
  - `components/ui/` — shadcn/ui primitives (generated; don't hand-edit).
  - `lib/tauri.ts` — the ONLY place `invoke()` is called; typed wrappers per command.
  - `lib/terminal-manager.ts` — non-React xterm registry; terminal output bypasses React state.
  - `lib/scripts.ts` — pure planner for project `run` scripts and split templates.
  - `lib/native-editing.ts` — OS text-editing chords → readline sequences; text-context detection.
  - `hooks/` — React hooks (use-shortcuts: keybindings; use-escape-to-close: modal dismiss).
  - `state/` — workspace metadata state for projects, worktrees, tabs, selection, icons.
  - `lib/utils.ts` — `cn()` + small reusable helpers.
- `apps/pragma/src-tauri/` — Rust backend (`src/lib.rs` = wiring; modules for db, pty, git, projects, worktrees, scripts, icons).
- `crates/pragma-cli/` — `pragma-cli` helper CLI that external agents call from terminals.
- `crates/pragma-client/` — Rust native-client transport, frame I/O, and SSH streamlocal bridge.
- `crates/pragma-core/` — pure Rust host business logic boundary, no Tauri dependencies.
- `crates/pragma-server/` — persistent Unix-socket host server; owns PTYs, scrollback, and runtime agent status fanout.
- `crates/pragma-protocol/` — shared daemon wire frames/framing used by daemon, Tauri app, and CLI.
- `packages/constants/` — dual TS+Rust package; the single source of truth for values
  shared across the language boundary (`schema.json` + `values.json`).
- `packages/sdk/` — `@pragma/sdk`, a typed Node/Bun wrapper that shells out to `pragma-cli`.
- `packages/github-helpers/` — `@pragma/github-helpers`, the `pragma-github` host-side sidecar scaffold.
- `packages/ai-helpers/` — `@pragma/ai-helpers`, the Node-side AI helper package and `pragma-ai`
  sidecar entrypoint for auth, model selection, prompts, commit planning, and PR draft generation.
- `packages/opencode-plugin/` — `@pragma/opencode-plugin`, an ESM opencode plugin that reports
  status via `@pragma/sdk` and owns its bundled Pragma launcher config/model scripts under `pragma/agents/`.
  Pragma does **not** bundle, install, or register the plugin — you register its built
  `dist/index.mjs` absolute path in opencode's own `plugin` config array yourself (opencode does
  **not** auto-load plugins from a directory; a file-path array entry is the only thing that loads,
  and the bare unpublished package name must never be registered).

## Where does it go?

| What you're adding                               | Where                                                    |
| ------------------------------------------------ | -------------------------------------------------------- |
| Value used by BOTH frontend and backend          | `packages/constants` (`values.json`)                     |
| Value/helper shared by multiple frontend modules | `apps/pragma/src/lib/`                                   |
| Reusable logic/types a future app could use      | a NEW `packages/*` package                               |
| Typed JS wrapper over the Pragma CLI             | `packages/sdk` (`@pragma/sdk`)                           |
| Built-in AI prompt/helper logic                  | `packages/ai-helpers` (`pragma-ai` sidecar)              |
| opencode runtime integration plugin              | `packages/opencode-plugin`                               |
| Code that calls the Rust backend                 | `apps/pragma/src/lib/tauri.ts`                           |
| A reusable UI primitive                          | `bunx shadcn@latest add <c>` → `components/ui`           |
| A feature component (composition of primitives)  | elsewhere under `src/`                                   |
| PTY/session ownership                            | `crates/pragma-server`                                   |
| Daemon wire frame types/framing                  | `crates/pragma-protocol`                                 |
| External agent report CLI                        | `crates/pragma-cli`                                      |
| Terminal rendering/output flow                   | `apps/pragma/src/lib/terminal-manager.ts`                |
| Project script config/headless lifecycle         | `apps/pragma/src-tauri/src/scripts.rs` + host `exec` RPC |
| Interactive run-script planning                  | `apps/pragma/src/lib/scripts.ts`                         |

## Decision rules

1. **Reuse before writing.** Grep for an existing helper/constant/component first.
2. **Extract on the second use.** Duplicated logic moves to `src/lib/` or a package.
3. **Create packages freely.** Small single-purpose packages > sprawling apps. If it's
   shared or could be, give it a `packages/*` home.
4. **No magic values across the boundary.** Put them in `@pragma/constants`.
5. **Never route terminal output through React state.** Workspace state tracks metadata only.
6. **Agent status is runtime-only.** Daemon snapshots live in memory; frontend status uses `useSyncExternalStore`; pins use localStorage; no SQLite migration.
7. **Agent model discovery parsing belongs to plugins.** Core executes configured commands from
   `~/.pragma/agents/<id>` and validates generic JSON only; host-specific parsers live under
   `packages/*-plugin/pragma/agents/<id>/scripts/`.
8. **Sweeping refactors for clarity are welcome** — this project is early.

Full details: see `AGENTS.md` at the repo root.
