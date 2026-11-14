# packages/omp-plugin — @pragma-sh/omp-plugin

Oh My Pi (`omp`, [omp.sh](https://omp.sh), `can1357/oh-my-pi`) integration. omp is a Pi
fork with a much larger runtime (subagents, approval modes, `ask`, plan mode), so it keeps
Pi's launcher factory and lifecycle state machine but owns its own extension wiring. Do not
copy Pi code here: import `@pragma-sh/pi-plugin/pragma-plugin-factory`, `/reporter`, and
`createSdkReporter` from `/extension-factory`.

Verified against omp **18.18.6** (Bun 1.4.4), model `openai-codex/gpt-5.6-luna`.

## Files

- `src/index.ts` — omp extension entry (`omp.extensions` in `package.json`).
- `src/extension.ts` — event wiring: main-session lifecycle, identity, naming, subagents, `ask`.
- `src/ask-form.ts` — maps an `ask` HTML form to Pragma questions with omp's own parser.
- `src/omp-modules.d.ts` — ambient types for the host-resolved `@oh-my-pi/pi-tui` modules.
- `src/subagents.ts` — process-wide subagent registry shared by every factory binding.
- `src/omp-api.ts` — structural slice of omp's extension API (see below for why).
- `src/pragma-plugin.ts` — `defineAgent` launcher via `createPiPragmaPlugin`, JSON model parser.

`@oh-my-pi/pi-coding-agent` is **not** a dev dependency: it ships raw TypeScript that needs
Bun ≥ 1.4 and its own workspace to typecheck, and pulls native addons. `omp-api.ts` mirrors
the shapes from omp's `src/extensibility/extensions/types.ts`; refresh it when omp changes
an event we read.

## Lifecycle mapping

| omp event                                                | Pragma report                                           |
| -------------------------------------------------------- | ------------------------------------------------------- |
| main `session_start`, `session_switch`, `session_branch` | `cleared`, `session-id`, native `session-name`          |
| main `before_agent_start` (`reason: "prompt"`)           | `session-id`, first-prompt `session-name`, user message |
| main `agent_start`                                       | `started`                                               |
| main `message_update` (assistant text)                   | streamed assistant message                              |
| main `agent_end`, `willContinue` true                    | nothing — the turn continues                            |
| main `agent_end` with assistant `stopReason: "aborted"`  | `cleared`                                               |
| main `agent_end` while subagents still run               | held; `stopped` when the last one settles               |
| main `agent_end` otherwise                               | `stopped`                                               |
| main `tool_execution_start` for `ask`                    | `attention` (question), `requestId` = tool call id      |
| main `tool_execution_end` for `ask`                      | `started` again (answered, cancelled, or timed out)     |
| main `session_shutdown`                                  | `cleared`                                               |
| sub `agent_start` / `agent_end` / `session_shutdown`     | `subAgentsActive` system message (no status)            |

**Every handler checks `ctx.agent.kind` first.** omp rebinds extension factories to every
subagent session (task tool, eval `agent()`, `/tan` clones) _in the same process_. Pi's
extension clears on factory load, which here would clear the parent's running dot each time
a subagent spawns — so the initial clear lives in the main `session_start` instead, and sub
bindings report nothing but activity. Subagents omp moves to worker threads (only at ≥ 9
concurrent) load a separate module copy and are not counted.

omp has no rename event. Its auto-generated title (`getSessionName()`) is polled on every
main event and wins over the first-prompt fallback once it appears.

Session identity: omp writes the session file lazily on the first completed turn, so a new
session's id is reported at that `agent_end` (same rule as Pi). Resume is
`omp --resume <id>` (id prefix or path); verified to restore the conversation.

## Launch and keys

- Models: `omp models --json` (selectors like `openai-codex/gpt-5.6-luna`, per-model
  `thinking` levels → `--thinking`). The parser skips leading banner noise.
- Interjections submit with **Kitty Enter** (`ESC [13u`): while a turn streams, omp steers
  the running turn with Enter. Pi's Alt+Enter is ignored by omp and failed `message-submit`.
- Prefill reuses Pi's factory timing (clear composer, then Kitty Enter).
- Slash commands: `.omp/commands`, `.agents/commands`, `~/.omp/agent/commands`,
  `~/.agents/commands`, plus `skill:` entries from the matching `skills/` dirs.
- Extensions do not load when omp's stdout is `/dev/null` (`omp -p … >/dev/null`); pipe
  output instead when probing by hand.

## Questions (`ask`)

omp's `ask` tool takes one HTML `<form>` and opens a native dialog. No extension hook can
return its answer (`tool_call` can only block or rewrite input), so:

- **Reporting:** on the main session's `tool_execution_start` for `ask`, the extension
  parses `args.html` with **omp's own** `@oh-my-pi/pi-tui/html-form/{parse,data}` and
  reports one question per named field (enabled radio/checkbox options as options; text
  inputs and single dropdowns as free text). One field is sent as `question`/`options`,
  several as `questions`.
- **Answering:** the watcher drives the dialog with real keys (`handleQuestionAnswers`,
  `questionSelectMode: "arrow-space"`, `questionOtherMode: "navigate"`,
  `questionFinalizeKeys: "\r"`): Down to the option, Space picks it, Enter moves to the next
  field, and a final Enter on Submit sends the form. Free text goes in the field's
  "Other" row (right after its options) or the text input; Esc cancels, which aborts the
  turn (omp throws `Ask tool was cancelled by the user`).
- **Those imports must be string literals.** omp maps `@oh-my-pi/*` to the copy inside the
  binary by rewriting extension source, which only sees literal specifiers. An
  `import(variable)` worked in `omp -p` but failed in a TUI session with
  `Cannot find package '@oh-my-pi/pi-tui'`. The build marks `@oh-my-pi/*` external.

## Not yet supported

`commandApproval` and `usageLimits` are in `excludeFeatures`:

- omp's default `tools.approvalMode` is `yolo`, and its `tool_approval_requested` event is
  notification-only, so there is no decision hook to block on.
- Credentials live in omp's SQLite `agent.db`, not an `auth.json`, so Pi's account
  providers do not apply. `omp usage --json` exposes per-account limits and is the obvious
  source for a future accounts provider.

## Build, install, verify

```sh
bunx turbo run build --filter=@pragma-sh/omp-plugin...
omp plugin link "$PWD/packages/omp-plugin"     # or: omp plugin install <path>
pragma-cli agent verify --agent omp --model openai-codex/gpt-5.6-luna --abort-input '\x1b'
```

Rebuild, then restart omp sessions (the bundle is read at startup). Register
`dist/pragma-plugin.mjs` through `plugins[]`; the plugin host only re-reads its catalog on
a Settings write or a plugins `reload` RPC.

## Branding

`assets/omp-badge.svg` is the vendor site's favicon, `https://omp.sh/favicon.svg`,
retrieved 2026-11-10 (dark rounded badge, gradient π — readable on light and dark). The
site and `can1357/oh-my-pi` are MIT licensed. The repo's `assets/icon.svg` is a white mark
on transparent and loses contrast on light backgrounds, so it is not used.

## Release onboarding

`packages/omp-plugin` is a Release Please component (`release-type: node`, manifest
`0.0.0`, so its first release is the config's `initial-version`, 0.1.0) and rides the next
release PR. It is **not yet published by that release**: `publish-plugins` in `release.yml`
only dispatches packages listed in `packages/plugin-registry/official.json`, and that list
must match `official.lock.json` (validated on every build/typecheck), which can only lock a
version that exists on npm. To finish shipping it:

1. Publish `@pragma-sh/omp-plugin` once by hand (a brand-new package rejects OIDC with
   `404 Not Found - PUT`), then `npm trust github @pragma-sh/omp-plugin --file plugins.yml
--repository pragma-sh/pragma --allow-publish`.
2. In one change: add it to `official.json` and `.github/workflows/plugins.yml`'s package
   choices (`scripts/release-config.test.ts` requires both lists to match), run
   `bun run plugins:lock`, and bump "ten agent plugins" in the root `AGENTS.md`.
3. If its release tag was already cut, dispatch `plugins.yml` with `operation=publish` and
   `ref=<omp-plugin tag>` to publish that release.
