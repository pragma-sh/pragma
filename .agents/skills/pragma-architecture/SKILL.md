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
    Owns reattach vs. restore on the first attach of a tab whose session is gone.
  - `lib/scripts.ts` — pure planner for project `run` scripts and split templates.
  - `lib/native-editing.ts` — OS text-editing chords → readline sequences; text-context detection.
  - `hooks/` — React hooks (use-shortcuts: keybindings; use-escape-to-close: modal dismiss).
  - `state/` — workspace metadata state for projects, worktrees, tabs, selection, icons.
  - `lib/utils.ts` — `cn()` + small reusable helpers.
  - `lib/external-store.ts` — synchronous snapshots and stable subscriptions shared by frontend stores.
- `apps/pragma/src-tauri/` — Rust backend (`src/lib.rs` = wiring; modules for db, pty, git, projects, worktrees, scripts, icons, `agent_sessions.rs` for host-routed launch preparation/restore).
- `crates/pragma-cli/` — `pragma-cli` helper CLI that external agents call from terminals.
- `crates/pragma-client/` — Rust native-client transport, frame I/O, and SSH streamlocal bridge.
- `crates/pragma-core/` — pure Rust host business logic boundary, no Tauri dependencies.
- `crates/pragma-server/` — persistent Unix-socket host server; owns PTYs, scrollback, runtime agent status fanout, and the durable agent-invocation store (`invocations.rs`, `agent_resume.rs`).
- `crates/pragma-protocol/` — shared daemon wire frames/framing used by daemon, Tauri app, and CLI.
- `packages/constants/` — dual TS+Rust package; the single source of truth for values
  shared across the language boundary (`schema.json` + `values.json`).
- `packages/sdk/` — `@pragma-sh/sdk`, a typed Node/Bun wrapper that shells out to `pragma-cli`.
- `packages/scratchpad/` — `@pragma-sh/scratchpad`, browser-safe interaction/runtime APIs and
  UI components for agent-authored MDX scratchpads.
- `packages/scratchpad-viewer/` — shared viewer/standalone-export HTML builders and
  prebundled browser runtimes. Desktop previews share its frame scope; exports stub
  SDK host calls, disable only built-in agent-send/decision buttons, add a Created with
  Pragma watermark, and are saved by the host's `scratchpads::ExportHtml` operation.
- `packages/code-viewer/` — `@pragma-sh/code-viewer`, the shared CodeMirror theme, grammar
  loader, and unified diff (`./codemirror`, used by the desktop editor) plus a
  self-contained read-only document Pragma Go embeds in a web view.
- `packages/fanout-view/` — `@pragma-sh/fanout-view`, the fanout view model (attempt
  grouping, labels, status wording, cross-attempt pairing) shared by desktop and mobile.
- `packages/plugin/` — `@pragma-sh/plugin`, the public TS API/runtime stub for pure Pragma
  plugins loaded from `.pragma/config.json`.
- `packages/automations/` — `@pragma-sh/automations`, the authoring API plus
  `pragma-automations` Bun sidecar supervised by `pragma-server`.
- `packages/create-pragma-plugin/` — `create-pragma-plugin` scaffolder CLI for
  single-bundle plugin projects.
- `packages/github-helpers/` — `@pragma-sh/github-helpers`, the `pragma-github` host-side sidecar scaffold.
- `packages/ai-helpers/` — `@pragma-sh/ai-helpers`, the Node-side AI helper package and `pragma-ai`
  sidecar entrypoint for auth, model selection, prompts, commit planning, and PR draft generation.
- `packages/opencode-plugin/` — `@pragma-sh/opencode-plugin`, an ESM opencode plugin that reports
  status via `@pragma-sh/sdk`. Launchable Pragma agents are `defineAgent` plugin contributions,
  not bundled `pragma/agents` JSON.
  Pragma does **not** bundle, install, or register the plugin — you register its built
  `dist/index.mjs` absolute path in opencode's own `plugin` config array yourself, or
  the `dist/v2` directory in `plugins` for OpenCode v2 (opencode does
  **not** auto-load plugins from a directory; a file-path array entry is the only thing that loads,
  and the bare unpublished package name must never be registered).

## Where does it go?

| What you're adding                               | Where                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Value used by BOTH frontend and backend          | `packages/constants` (`values.json`)                              |
| Value/helper shared by multiple frontend modules | `apps/pragma/src/lib/`                                            |
| Reusable logic/types a future app could use      | a NEW `packages/*` package                                        |
| Typed JS wrapper over the Pragma CLI             | `packages/sdk` (`@pragma-sh/sdk`)                                 |
| Scratchpad runtime or first-party MDX component  | `packages/scratchpad` (`@pragma-sh/scratchpad`)                   |
| Public Pragma plugin authoring API               | `packages/plugin` (`@pragma-sh/plugin`)                           |
| Read-only code/diff rendering off the desktop    | `packages/code-viewer` (`@pragma-sh/code-viewer`)                 |
| How a client presents fanouts                    | `packages/fanout-view` (`@pragma-sh/fanout-view`)                 |
| Automation authoring API / host sidecar          | `packages/automations` (`@pragma-sh/automations`)                 |
| Pragma plugin scaffolder templates/CLI           | `packages/create-pragma-plugin`                                   |
| Built-in AI prompt/helper logic                  | `packages/ai-helpers` (`pragma-ai` sidecar)                       |
| opencode runtime integration plugin              | `packages/opencode-plugin`                                        |
| Code that calls the Rust backend                 | `apps/pragma/src/lib/tauri.ts`                                    |
| A reusable UI primitive                          | `bunx shadcn@latest add <c>` → `components/ui`                    |
| A shipped default color/design token             | `apps/pragma/src/index.css` ONLY (parsed by `theme-tokens.ts`)    |
| A sourced built-in theme palette                 | `apps/pragma/src/lib/theme-presets.ts`                            |
| User color overrides (global/project)            | `.pragma/theme.json` via `apps/pragma/src/lib/theme.ts`           |
| A feature component (composition of primitives)  | elsewhere under `src/`                                            |
| PTY/session ownership                            | `crates/pragma-server`                                            |
| Durable agent invocation + auto-resume record    | `crates/pragma-server/src/invocations.rs` + `agent_resume.rs`     |
| Desktop launch preparation / session restore     | `apps/pragma/src-tauri/src/agent_sessions.rs`                     |
| Resume argv (plugin-owned)                       | `AgentDefinition.launch.resume` (`packages/plugin/src/agent.ts`)  |
| Fanout rules (selectors, branches, status)       | `crates/pragma-core/src/fanout.rs`                                |
| Fanout record, state machine, pick transaction   | `crates/pragma-server/src/fanouts.rs`                             |
| A fanout side effect (git, PTY, catalog, AI)     | `crates/pragma-server/src/fanout_host.rs` (the `FanoutHost` seam) |
| Daemon wire frame types/framing                  | `crates/pragma-protocol`                                          |
| External agent report CLI                        | `crates/pragma-cli`                                               |
| Terminal rendering/output flow                   | `apps/pragma/src/lib/terminal-manager.ts`                         |
| Project script config/headless lifecycle         | `apps/pragma/src-tauri/src/scripts.rs` + host `exec` RPC          |
| Interactive run-script planning                  | `apps/pragma/src/lib/scripts.ts`                                  |

## Decision rules

1. **Reuse before writing.** Grep for an existing helper/constant/component first.
2. **Extract on the second use.** Duplicated logic moves to `src/lib/` or a package.
3. **Create packages freely.** Small single-purpose packages > sprawling apps. If it's
   shared or could be, give it a `packages/*` home.
4. **No magic values across the boundary.** Put them in `@pragma-sh/constants`.
5. **Never route terminal output through React state.** Workspace state tracks metadata only.
6. **Runtime status is ephemeral; recovery identity is durable.** Status dots/messages live
   in memory (frontend store via `useSyncExternalStore`; pins in localStorage). The durable
   record is the host's `agent-invocations.db` row plus the harness session id an integration
   reports (`reportSessionId` / `agent report session-id`) — never client DB, localStorage,
   or plugin state. A restore is driven by the host and the plugin's `launch.resume` callback;
   it resumes a conversation, never replays prompts or startup input.
   The desktop's `SessionRestoreDialog` displays the host's boot-scoped
   `tabs.sessionRestoreStatus` snapshot (all connected hosts, including background tabs).
   Its dismissal is cosmetic and must never cancel or initiate recovery.
7. **Agent model discovery parsing belongs to plugins.** Plugin agents provide static models or
   async model providers; host-specific parsing must not be added to Rust/Tauri IPC.
8. **Sweeping refactors for clarity are welcome** — this project is early.

Full details: see `AGENTS.md` at the repo root.

Computer tasks follow the host-owned pattern: `computer/tasks.rs` stores redacted metadata and volatile values, `computer/tasks/runner.rs` validates decisions around the direct-action pipeline, and `pragma-ai computer-decide` supplies bounded Jev choices. Gateway computer RPC/activity require a distinct owner-only local credential; loopback is not a local identity signal. The SDK mirrors these calls; desktop JPEG preview channels keep pixels out of activity events.

Missing computer-use OS grants raise a host approval before native target resolution,
even for already allowed callers. The desktop's `use-computer-permissions` and
`ComputerPermissionControls` share setup between Settings and the approval popup;
poll without prompting, request only on a button press, then require an explicit
Pragma approval once macOS grants are enabled.

An explicit macOS Screen Recording request must open its System Settings pane if
the native request returns denied (the OS may not repeat its initial prompt).
Passive checks and Accessibility-only requests must not open that pane.

The host tracks desktop controllers by connection identity, with the newest active
and older live connections as standbys. Cleanup removes only that connection;
only an active disconnect fails pending controls, then the latest standby resumes.
Computer use's `desktopConnected` must follow these live connections, never an OS
process check. Acknowledge controller registration so reconnect can republish workspace state.

macOS helper bundles are staged and signed by `apps/pragma/src-tauri/scripts/stage-macos-helper.ts`, then copied to `Contents/Helpers`. Tauri custom files are not recursively signed; preserve that signing order and temporary-keychain cleanup.

The helper's cursor artwork is `crates/pragma-computer/icons/icon.svg`, generated
into ICNS/ICO with the Tauri CLI (commands in that crate's AGENTS.md). Stage the
macOS icon and Info.plist before signing, and include both in the bundle-cache hash;
Windows embeds the ICO through `windows.rc`.

Successful helper dev signing persists the chosen identity in the gitignored
`apps/pragma/src-tauri/dev-signing-identity.local`; explicit
`PRAGMA_DEV_SIGNING_IDENTITY` overrides it. Preserve this across rebuilds so a
different launching shell does not silently replace a certificate with ad hoc signing.

The computer PiP's Focus app arrow uses the host's desktop-only `focusSession` control and the same session lease as its preview. Only an unknown-operation rejection falls back to `status` plus `pragma-platform::desktop::focus_app` for older daemons; never use an agent action that acquires a competing lease. macOS overlay construction relies on `vendor/wry` honoring `.focused(false)`; early creation alone cannot prevent focus theft when computer use is enabled mid-run.

Preview startup must tolerate UI overlays/HMR ahead of the native binary:
`streamComputerFrames` falls back to immediate, sequential `computer_rpc` frame polling
only when `computer_start_preview` is unknown. Both paths release on hide or minimize
and suppress frames arriving after cancellation.
Check native permissions before starting captures, rechecking a missing macOS grant
once while idle so the host can replace a helper with cached denial. Never restart
the helper on every frame or prompt for OS permissions automatically.
The PiP rechecks permissions on a bounded interval during capture failures and
recognizes explicit Screen Recording errors independently of the status lookup.
Clear stale frames so the recovery button remains visible; request the grant only
on a button press, with `permission: "screenRecording"`.

Computer-use pause/takeover is host-owned durable `paused` task state plus a session latch. The helper guards session epochs between native events; pause/resume must not revive queued actions. Per-session Stop releases leases but retains a `stopped` pause latch for the desktop Restart control. CLI callers must ask the user to resume/restart before continuing.
