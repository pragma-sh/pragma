# @pragma/junie-plugin

Pragma integration for the **JetBrains Junie CLI** (`junie`). Two halves:

- **`hooks/`** — the status bridge. `hooks/hooks.json` maps Junie's hook events to
  `hooks/report.sh`, which turns each one into a `pragma-cli agent report`.
- **`src/`** — the Pragma-side plugin bundle (`dist/pragma-plugin.mjs`): the launcher,
  the model provider, the usage-limit provider, and the TUI watcher.

Everything here is self-contained. Nothing in Pragma core, the server, the CLI, or the
SDK knows Junie exists — see the host-tool plugin rule in the root `AGENTS.md`.

Verified against **Junie 26.8.3 (2548.5)** on macOS.

## Install

```bash
bun run --filter @pragma/junie-plugin build         # dist/pragma-plugin.mjs
bun run --filter @pragma/junie-plugin install:local # hooks -> ~/.junie/config.json
```

Then register this package directory in `plugins[]` of a `.pragma/config.json` (global
or project) and reload Pragma's plugins.

`install:local` **merges** into `~/.junie/config.json`, preserving every other key, and
replaces any entry a previous install of this package left behind, so it is idempotent.
It has to be the global file: Junie ignores a project-local `.junie/config.json` by
default "for safety", so a per-checkout install would simply never fire. The installed
commands point back at this checkout, so edits to `hooks/report.sh` take effect on the
next Junie session with no reinstall.

## Hook -> status map

Junie dispatches seven hook events. All seven are wired except `StopFailure`'s
observability-only siblings.

| Junie event         | `report.sh` mode | Pragma report                                               |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `SessionStart`      | `cleared`        | `cleared` (skipped when the in-flight turn is this session) |
| `UserPromptSubmit`  | `started`        | `started` + user message + session name + abort watcher     |
| `PreToolUse`        | `pre-tool`       | `started` re-assert + tool message                          |
| `PermissionRequest` | `permission`     | `attention --kind command`, then blocks on `await-decision` |
| `Stop`              | `stopped`        | assistant reply, then `stopped`                             |
| `StopFailure`       | `failed`         | `cleared` + system message                                  |
| `SessionEnd`        | `cleared`        | `cleared` + forgets the cached session                      |

Two things reach Pragma without any hook, straight from `events.jsonl` (see
_Gotchas_): a cancelled turn, and every question Junie asks.

## What Junie's payloads do and do not carry

Junie's stdin envelope is snake_case like Claude Code's, but two fields that the sibling
bridges lean on are missing, and both shaped this implementation:

- **Only `SessionStart` and `UserPromptSubmit` carry `session_id`.** `PreToolUse`,
  `PermissionRequest`, `Stop`, `StopFailure` and `SessionEnd` carry none, so the id is
  cached per tab on the two events that have it and reused by the rest. This is also why
  there is no per-event session pinning: a stray event cannot be attributed to a session
  at all.
- **There is no `transcript_path`.** Junie's session log lives at
  `<junie home>/sessions/<session_id>/events.jsonl`, which `session_dir()` reconstructs.
  `SessionStart`'s `cwd` is Junie's own home directory (Junie chdirs there before running
  hooks), so it is preferred, with `$JUNIE_HOME` and `~/.junie` as fallbacks.

Observed payloads (26.8.3):

```json
{"hook_event_name":"SessionStart","session_id":"session-260806-104937-1ja5","cwd":"/Users/me/.junie","project_path":"/repo","source":"startup"}
{"hook_event_name":"UserPromptSubmit","session_id":"session-…","cwd":"…","project_path":"…","prompt":"…"}
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi","run_in_background":false}}
{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"### Summary\n…"}
{"hook_event_name":"SessionEnd","reason":"other"}
```

## Gotchas worth keeping

- **Silence auto-approves a `PermissionRequest`.** Junie's contract is the opposite of
  Claude Code's: a hook that exits 0 with no decision _approves_ the action. So the
  timeout branch cannot stay quiet the way `claude-code-plugin`'s does — it returns
  `{"decision":"ask"}`, which is Junie's "show your own prompt" verdict. Getting this
  wrong would let an unattended tab approve everything. The same rule bites twice more:
  the outside-Pragma early exit (`PRAGMA_SERVER_SOCKET`/`PRAGMA_DAEMON_SOCKET` unset)
  and the no-in-flight-turn branch of `permission` must also answer `ask` instead of
  exiting silently — the hooks are installed globally (`~/.junie/config.json`), so a
  Junie launched outside a Pragma terminal would otherwise have every sensitive action
  rubber-stamped.
- **`PermissionRequest`'s default hook timeout is 10s.** `hooks.json` raises it to 310 so
  it outlives `PRAGMA_APPROVAL_TIMEOUT` (300s) and the timeout branch, not Junie's
  timeout, decides.
- **There is no `PostToolUse` hook.** `PreToolUse` is the only mid-turn signal, so it
  doubles as the "still running" heartbeat that drops a resolved attention back to "in
  progress".
- **The `submit` tool is not a tool call to report.** Junie ends every turn by calling
  `submit`, immediately followed by `Stop`; reporting it only races that `Stop`.
- **A cancelled turn fires no hook at all.** It is recorded in `events.jsonl` as a
  `ResultBlockUpdatedEvent` with `"cancelled":true` (a failed one as
  `AgentTaskFailedEvent`), which the per-turn watcher polls past the turn's starting byte
  offset. Scoping to the offset is what stops an earlier turn's cancel from clearing a
  new one.
- **Event-log blocks are replacements, not deltas.** Each `*BlockUpdatedEvent` carries the
  whole current text of its `stepId`, so `assistant_text_since` keeps the newest record
  per `stepId` (in first-seen order) instead of concatenating every record — concatenating
  would repeat the reply once per streamed update.
- **Questions fire no hook at all.** `ask_user` / `ask_user_choice` are dispatched
  through Junie's async-request channel, not the tool pipeline: asking a question emits
  **no** `PreToolUse`, only an `AskAsyncRequestUpdatedEvent` in `events.jsonl` carrying
  `request.question`, `request.options[].title/description` and `request.id`. The
  per-turn watcher raises the attention from that record (`status: "IN_PROGRESS"`) and
  drops back to `started` when a later record for the same `stepId` is no longer
  in progress. The `pre-tool` arm still matches the two tool names, but only so that a
  future build routing them through the tool pipeline cannot re-assert `started` over a
  live question.
- **The reply has to be typed, and Junie's list ignores digits.** No hook can answer a
  question, so `createTuiWatcher` (`handleQuestionAnswers: true`) sends keystrokes —
  with `questionSelectMode: "arrow-space"`, because Junie's prompt navigates with Down,
  marks the row with Space (`space to select`), and submits with Enter, and its
  custom-answer row is a plain input that must not be opened with Enter first. Command
  approvals are the reverse — a real blocking hook — hence `handleDecisions: false`.
- **Subagents are invisible.** Junie runs them in-process and fires no per-agent hook
  (`PreToolUse` carries no agent id), so `subagents` is in `excludeFeatures`.

## Launcher

`junie` with:

| Selection       | Flag                                         |
| --------------- | -------------------------------------------- |
| model           | `--model <id>`                               |
| reasoning       | `--effort low\|medium\|high`                 |
| permission mode | `--brave` for `brave`, nothing for `default` |

Junie's approval behaviour is the `brave_mode` setting (`off` / `auto` / `on`, default
`auto`), and `--brave` is its only command-line lever — it forces `on`. There is no flag
for `off`, so the `default` mode passes nothing and keeps whatever the user configured.

The model catalog is **not** available from any subcommand; it comes from the ACP
`session/new` response's `configOptions` (see below). `effort` is a session-wide setting
rather than a per-model one, so the same reasoning list is attached to every model.

`prefillDelayMs` is 6s because Junie boots a JVM before painting its TUI.

## ACP transport (`src/acp.ts`)

Both the model catalog and the quota come from a short-lived `junie --acp=true` process
speaking JSON-RPC over stdio, so Pragma never reads Junie's credentials.

Unlike a one-shot extension method, both need a _session_, and `/usage` needs the session
id that only `session/new` can supply — so `buildCommand` writes a POSIX `sh` program
that keeps Junie's stdin open through a FIFO and feeds the prompt back once the reader
has parsed the id. `sdk.exec.run` has no stdin channel, and running it there (rather than
in-process) is what makes a remote project's Junie the one that answers.

**The program is POSIX-only, and `sdk.exec.run` uses the host's default shell.** On
Windows that is PowerShell or cmd, where `trap`, `mkfifo`, and `case…esac` are syntax
errors, so `readJunieAcp` first probes for a POSIX shell (`SHELL_PROBE`) and reports the
host as `unsupportedShell` when none is there. Model discovery then returns an empty
catalog (the launcher still opens on Junie's default model) and the usage provider
reports `unsupported` instead of failing on a parse error. The peak-cache reads/writes
in `usage-limits.ts` (`mkdir -p`, `cat`, `printf`) are POSIX-only for the same reason,
but they are unreachable when the probe fails because the ACP read short-circuits first.

`--cache-dir` points the probe at a throwaway directory. Junie still creates an empty
`~/.junie/sessions/<id>/` per probe, but those never reach `sessions/index.jsonl`, so
they do not pollute `junie --resume`. The refresh interval is 15 minutes for that reason
as much as for the JVM start (~2s for models, ~4s for usage).

## Usage limits

`/usage` renders one of two lines depending on the license:

```
License: JetBrains Trial
Balance left: $4.99
```

```
License: AI Pro
Quota: 1,250 credits remaining
```

**JetBrains only ever reports what is left.** `IngrazzioAuthInfo` — the record behind
both lines — carries `balanceLeft`, `balanceUnit`, `licenseType` and `active`, and
nothing in the CLI exposes the period's starting allowance. Pragma's `UsageLimit` is a
used/limit pair, so the denominator is reconstructed from the highest balance this
machine has seen, cached in `~/.pragma/cache/junie-usage.json` and keyed by
`<license>|<unit>`. A balance only falls as credits are spent and only rises on a top-up
or renewal, so the peak _is_ the current period's allowance once one period has been
observed. Consequences to keep in mind:

- The very first reading is always "0% used"; the bar becomes meaningful as the balance
  drops.
- A renewal or top-up raises the peak, which restarts the period correctly.
- A first-ever reading of zero has no usable denominator and reports `unavailable`
  (`unsupported`) rather than an empty bar.

Peak I/O goes through `ctx.sdk.exec.run`, never `node:fs` / `node:os`. The same
`dist/pragma-plugin.mjs` loads inside the production desktop webview via a blob-URL
import, where a bare `node:` import fails the whole plugin with "Importing a module
script failed", and a direct local read would also hit the wrong machine for a remote
project.

## Icon

`assets/junie.svg` is JetBrains' official Junie mark, downloaded from
`https://junie.jetbrains.com/favicons/favicon.svg` on 2026-08-06. It is plain geometry
(three `<path>` elements, `#48E054`) with no scripts, remote references, or embedded
raster data, and it reads on both light and dark backgrounds. Refresh it from that URL.

## Tests

```bash
bun run --filter @pragma/junie-plugin test
```

`test/report.test.ts` drives the real `hooks/report.sh` through `sh` with a fake
`pragma-cli` on `PATH` and a fake Junie home, including the background abort watcher.
Cases that depend on JSON parsing are skipped when `python3` is unavailable, because the
bridge degrades to status-only reporting there.

Integration is verified with the real agent:

```bash
pragma-cli agent verify --agent pragma.junie \
  --prompts packages/junie-plugin/verify-prompts.json \
  --pick-model-cmd "--model gemini-3.1-flash-lite"
```

Pick the cheapest model — the catalog default is not it — and reload Pragma's plugins
after every rebuild so the server's catalog picks up the new bundle.

**`verify-prompts.json` is not optional.** The approval scenarios ship prompts that run
`ls`, and Junie's default `brave_mode: auto` auto-approves read-only commands outright:
no `PermissionRequest` fires, and the scenario fails with "agent settled without command
attention" even though the approval path works. The override swaps in `rm -f` on the
same `pragma-verify-*` paths (which the verifier matches on), which Junie does ask about.
Keep the `pragma-verify-…` token in any prompt you change.

Two more flags matter here:

- `--step-timeout` must exceed `PRAGMA_APPROVAL_TIMEOUT` (300s) or `decision-timeout`
  can never reach its fallback. Use `--step-timeout 360 --include-slow` for that one.
- Each session is a JVM. `--jobs 3` is comfortable; the abort scenarios time out on a
  loaded machine well before the plugin is at fault, so re-check a failure with
  `--jobs 1` before believing it.
