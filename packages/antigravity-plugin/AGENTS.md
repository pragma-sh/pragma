# packages/antigravity-plugin — Google Antigravity CLI (`agy`) integration

Two halves, like every hook-route agent plugin:

- **`agy-plugin/`** is a native Antigravity plugin (`plugin.json` + root-level `hooks.json`,
  `hooks/report.sh`, and the bundled `dist/hook.mjs`). `scripts/install-local.ts` (shipped
  as `dist/install.mjs`, the `pragma-plugin.json` install command) runs
  `agy plugin install agy-plugin/`, which **copies** it to `~/.gemini/config/plugins/pragma`.
  A copy rather than a `plugins.json` link on purpose: Pragma deletes superseded
  `~/.pragma/plugins/npm/...` folders, and a link would leave agy running hooks that no
  longer exist. Edits therefore need `bun run install:local` (build + reinstall), then a
  new agy session.
- **`src/pragma-plugin.ts`** is the Pragma side: launcher (`agy`), models (`agy models`),
  permission modes, resume, usage limits, and the watcher.

Everything below was verified against **agy 1.5.13** with a logging probe plugin and a PTY
driver; re-check it when agy changes.

## Hook lifecycle (only six events exist)

`agy plugin validate` lists the only events: `SessionStart`, `PreInvocation`,
`PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`. There is **no** prompt-submit,
permission-request, notification, or session-end hook. Payloads are camelCase and every one
carries `conversationId`, `transcriptPath`, `lastUserInput`, `hookEventName`, `cwd`. Hooks
inherit the terminal environment (so `PRAGMA_*` reaches them) and run from the plugin folder.

| agy event                       | Report                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `SessionStart` (user)           | `session-id`; `cleared` when no turn is tracked                 |
| `PreInvocation`, `#0`           | turn start: `started`, user message, `session-name` (first)     |
| `PreInvocation`, later          | `started` heartbeat (drops a resolved attention)                |
| `PostInvocation`                | streams assistant text from the transcript (stable id per turn) |
| `PreToolUse` `ask_question`     | `attention --kind question` (single or multi-question)          |
| `PreToolUse` other              | `started` + tool message                                        |
| `PostToolUse`                   | `started` (an approved command only shows up here)              |
| `Stop` `NO_TOOL_CALL`, …        | final assistant sync, then `stopped`                            |
| `Stop` `USER_CANCELED`, `ERROR` | `cleared`                                                       |

- `invocationNum` restarts at 0 for **every** user turn, so `PreInvocation #0` is the turn
  start. `SessionStart` fires only for a new conversation (lazily, at its first prompt);
  `agy -c` continues without one.
- **A PreToolUse hook must print a verdict.** Empty output or `{}` _denies_ the tool
  ("tool call denied by pre-tool hook"). `{"decision":"ask"}` is the neutral verdict that
  leaves agy's own policy in charge. `report.sh` prints it first, before anything that can
  fail, and the TypeScript never writes stdout.
- **Sub-agents** (`invoke_subagent`) are separate conversations with their own hooks,
  `SessionStart` … `Stop`, and an empty `lastUserInput`. They are counted per turn
  (`subAgentsActive`); a parent `Stop` with `fullyIdle: false` while one runs waits for the
  last sub-agent's `Stop`.
- The transcript (`transcript_full.jsonl`) has `USER_INPUT` steps (`source: USER_EXPLICIT`,
  prompt inside `<USER_REQUEST>`) and `PLANNER_RESPONSE` steps whose `content` is the reply.
  A cancelled step is never written: there is no cancel record.
- Parallel sub-agent hooks run concurrently, so `dist/hook.mjs` serialises a tab's state
  file and reports behind an atomic `mkdir` lock.

## What only the screen shows (the watcher, `src/screen.ts`)

- **Approvals.** PreToolUse runs _before_ agy's permission check and cannot tell whether a
  prompt follows, so the prompt block is the signal ("Requesting permission for: … Run
  this command? > 1. Yes, …"). agy paints it in one contiguous write. The watcher reports
  `attention --kind command`; watcher-kit (`handleDecisions: true`) answers with `1`
  (approve) or Up + Enter (deny: Up from row 1 wraps onto "No, cancel", whatever number of
  "always allow" rows sit between). Never select rows 2/3: they persist allow rules (row 3
  writes `settings.json`).
- **Interrupts.** Esc and a declined approval end the turn with **no hook at all**. The only
  trace is "⎿ Interrupted · What should Antigravity CLI do instead?", which the watcher
  turns into `cleared`. It is ignored only inside a full-screen repaint (a clear-screen
  sequence until the next footer). Do not gate it on the "esc to cancel" busy footer
  instead: under parallel load agy coalesces frames and can skip that footer entirely,
  which made `abort-mid-run` fail its first attempt.
- **The trust gate** on first launch in a folder: the watcher accepts it (Enter on the
  default row, as the Cursor plugin does), otherwise the prefilled prompt is typed into the
  dialog and lost.
- No process-exit hook exists, so the watcher's `finally` reports `cleared`.
- **Questions** use watcher-kit defaults: digits select-and-advance, "Write-in..." is the
  row after the options (Down × n + Enter opens it), Esc skips. agy prefixes its suggested
  option with "(Recommended) "; the hook strips it. Multi-select questions stay native.

## Launch options

- Models: `agy models` prints `<id>\t<name>`; effort is part of the id, so the list is flat.
- Permission modes: `default` (agy's own mode, Auto unless changed), `ask`
  (`--settings '{"permissions":{"ask":["command(*)"]}}'`, session-only, never saved),
  `accept-edits` / `plan` (`--mode`), `skip` (`--dangerously-skip-permissions`).
- Resume: `agy … --conversation <conversationId>`.
- Usage limits: `agy -p /usage --output-format json` answers without a turn or quota;
  `command.data.groups[].buckets[]` → `remaining_fraction` + `reset_time`.

## Verifying

```sh
bun run --filter @pragma-sh/antigravity-plugin install:local   # build + agy plugin install
# register this package's path under plugins[] in ~/.pragma/config.json, then reload:
curl -s -X POST -H "Authorization: Bearer $PRAGMA_LOCAL_GATEWAY_TOKEN" \
  -H 'content-type: application/json' -d '{"action":"reload"}' "$PRAGMA_GATEWAY_URL/v1/rpc/plugins"

# Everything except approvals, in agy's default (Auto) mode:
pragma-cli agent verify --agent antigravity --pick-model-cmd "--model gemini-3.8-flash-low" \
  --scenario basic-reply … --scenario stream-integrity   # every non-approval scenario
# Approvals: Auto mode runs the verifier's `rm -f /tmp/...` without asking, so ask first:
pragma-cli agent verify --agent antigravity --scenario command-allow --scenario command-deny \
  --scenario abort-mid-approval \
  --pick-model-cmd "--model gemini-3.8-flash-low --settings '{\"permissions\":{\"ask\":[\"command(*)\"]}}'"
```

The `--settings` JSON must be shell-quoted inside the snippet: the launcher passes it through
a shell, and unquoted the session never starts ("no running status even after prefill
retries"). `gemini-3.8-flash-low` is the cheapest model that spawns sub-agents. In ask mode
`command-no-permission` fails by design (every command asks).

`decision-timeout` (slow, `--include-slow` only) **fails** and is expected to: it waits for
an approval hook to time out and settle, but agy has no blocking approval hook. Its native
prompt is on screen from the start and stays there, so the session correctly remains in
`command` attention until someone answers it, locally or from Pragma.

## Icon

`assets/antigravity.svg` is the official "Icon - Full Color" SVG from the Antigravity press
page, <https://www.antigravity.google/press>
(`/assets/image/brand/antigravity-icon__full-color.svg`), downloaded 2026-11-20 and
unmodified (no scripts, remote references, or raster data; readable on light and dark). The
press page publishes the assets with no usage terms beyond "Press Guidelines"; refresh from
the same URL. `apps/www/public/agents/antigravity.svg` is a copy, and the build copies it to
`agy-plugin/dist/logo.svg` for agy's plugin manifest.
