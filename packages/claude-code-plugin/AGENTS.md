# packages/claude-code-plugin — @pragma/claude-code-plugin

Static Claude Code plugin that reports agent status and plan usage into Pragma. Unlike the opencode
plugin, **Claude Code has no in-process JS plugin API** — its only live extension point
is shell-command hooks — so this is the **CLI route, not the SDK**: a real Claude Code
plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`) where every hook shells out
to a single bundled script (`hooks/report.sh`) that calls `pragma-cli`. (The TS here
defines Pragma-side agent, watcher, and usage contributions; Claude never loads it.)

## File map

```
packages/claude-code-plugin/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (do NOT set hooks here — see gotcha below)
│   └── marketplace.json     # For `claude plugin marketplace add`
├── assets/                  # Claude Code brand assets used by the built-in launcher
├── src/pragma-plugin.ts     # Agent, watcher, and structured usage-limit declaration
├── hooks/
│   ├── hooks.json           # Hook definitions — auto-loaded by Claude Code
│   └── report.sh            # Event → pragma-cli translator (the actual logic)
├── src/pragma-plugin.test.ts # Tests Pragma-side usage and watcher contributions
└── test/report.test.ts       # Drives report.sh with a fake pragma-cli on PATH
```

Each hook in `hooks.json` invokes `sh "$CLAUDE_PLUGIN_ROOT/hooks/report.sh" <event>`.
`$CLAUDE_PLUGIN_ROOT` is exported by Claude Code for plugin hooks; running through `sh`
means the script works regardless of its executable bit. Keeping the logic in one script
(not inline JSON one-liners) is what makes the abort handling below testable.

## Hook → status mapping

| Hook                         | `report.sh` arg  | Reports                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`               | `cleared`        | `cleared` status only (+ tears down any stale watcher)                                                                                                                                                                                                                                                                          |
| `SessionEnd`                 | `cleared`        | `cleared` status only (+ tears down the watcher)                                                                                                                                                                                                                                                                                |
| `UserPromptSubmit`           | `started`        | `started` + `session-name` (once per `session_id`, derived from the first real prompt's first line, ~48 chars) + user prompt message (+ spawns the abort watcher — see below). A synthetic `<task-notification>` prompt (subagent completion auto-resume) reports `started` but renders a system note, never a fake user bubble |
| `Stop`                       | `stopped`        | `stopped` + `last_assistant_message` (or transcript fallback); `cleared` after an interrupt; stays `started` while tracked subagents or `background_tasks` remain active — see below                                                                                                                                            |
| `SubagentStart`              | `subagent-start` | Tracks each active child and re-asserts `started`                                                                                                                                                                                                                                                                               |
| `SubagentStop`               | `subagent-stop`  | Removes only that child; final status remains owned by the parent `Stop`                                                                                                                                                                                                                                                        |
| `PostToolUse`                | `running`        | `started` **iff** a turn's marker exists; else nothing (see below)                                                                                                                                                                                                                                                              |
| `PermissionRequest`          | `permission`     | `attention --kind command` (+ command + requestId) **and blocks for the verdict** — see approvals below. `AskUserQuestion` branches to `attention --kind question` (+ question + options + requestId) and blocks for the answer — see questions below                                                                           |
| `Elicitation`                | `attention`      | `attention` (no `--kind`) **iff** a marker exists — MCP input, fast path                                                                                                                                                                                                                                                        |
| `Notification` `idle_prompt` | `idle`           | `cleared` **iff** a turn's marker still exists; else nothing                                                                                                                                                                                                                                                                    |

`Stop` always trails `UserPromptSubmit` on a _normal_ turn, so the happy path needs no
state machine. Cancelled turns fire **no hook at all** — that is the whole problem the
abort watcher below exists to solve.

Claude Code adds `agent_id` to common hook input only when a hook fires inside a
subagent. `report.sh` consumes every payload before changing marker state and exits
immediately when that field is present. It also recognizes `hook_event_name` set to
`SubagentStop` and `agent_transcript_path` as defensive payload-variant signals, so
subagent tool/stop events cannot overwrite the parent agent's status. For Claude builds
that emit child completion as a plain `Stop` without those fields, the script pins each
Pragma tab to the parent `session_id` observed at `SessionStart` / `UserPromptSubmit`
and ignores events carrying any other session ID.

## Background subagents: a parent `Stop` is not "done"

When the parent launches a background subagent (the `Agent` tool) and ends its own
inference turn ("agent is searching, standing by"), Claude Code fires a **real parent
`Stop`** — same session, no `agent_id` — while the subagent is still working. Verified
against a live session: the subagent's completion later auto-resumes the parent through
a synthetic `UserPromptSubmit` whose `prompt` is a `<task-notification>` block, followed
by the final `Stop`. Reporting `stopped` on that intermediate `Stop` flipped the tab to
the green done dot mid-run — the "subagent finished = session finished" bug.

The bridge tracks every **`SubagentStart` / `SubagentStop`** by `agent_id` in per-tab
marker files, so overlapping children cannot collapse into one boolean. A parent `Stop`
stays `started` while any marker remains; each child stop removes only its own marker,
and the parent's final `Stop` owns the finished report. Session start/end clear stale
markers. Rich messages derive `subAgentsActive` from those markers; never hardcode zero,
or chat consumers and `agent verify` cannot observe real parallel activity. The `Stop`
payload's **`background_tasks`** array remains a compatibility
fallback: entries like
`{"type": "subagent", "status": "running", ...}` mean the session is still busy, so
`report.sh` re-asserts `started`, keeps the marker + abort watcher alive (a cancel during
the subagent phase must still clear), and surfaces the parent's interim reply as a chat
message. Only `type == "subagent"` counts — a long-lived background _bash_ task (e.g. a
dev server) must not hold the tab on "running" forever. The final `Stop` (no running
subagents) reports `stopped` normally.

## Raising `attention` the instant a prompt appears (`PermissionRequest`)

The `Notification` `permission_prompt` event is a **debounced desktop notification**, not
a prompt-shown signal — Claude Code waits ~3–5s before firing it. Driving the red "needs
attention" dot from it lagged that far behind the prompt actually appearing.

`PermissionRequest` (and `Elicitation` for MCP input) fire **the instant the dialog is
shown**, and — unlike `PreToolUse` — only when the user would actually be prompted (never
on an auto-approved tool), so they're the direct equivalent of opencode's `permission.ask`
event. We drive `attention` from them for a ~immediate (<500ms) transition.

## Approving from a Pragma toast (`PermissionRequest` blocks)

`PermissionRequest` is a **blocking** hook: Claude Code waits for its stdout before
proceeding. The `permission` case in `report.sh` uses that to approve remotely:

1. It extracts the command from the hook's stdin JSON (`tool_input.command`; Read,
   Write, and Edit requests render as `<tool> <file path>` rather than raw input JSON),
   mints a `requestId`, and reports
   `attention --kind command --command <cmd> --request-id <id>` — so a Pragma approval
   toast shows the command with **Approve**/**Deny**.
2. It then blocks on `pragma-cli agent await-decision --request-id <id>
--timeout ${PRAGMA_APPROVAL_TIMEOUT:-300}`, which unblocks when the app publishes the
   verdict (the user clicked a button; server fans out an `AgentDecision`).
3. It emits Claude Code's `PermissionRequest` decision JSON —
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}` —
   so approve runs the tool and deny rejects it, no terminal interaction needed.
4. **Either verdict re-asserts `started` first** (marker-guarded). An approved tool also
   fires `PostToolUse` when it finishes, but a **denied one never runs** — without the
   re-assert the tab stayed stuck on the command attention until `Stop`.
5. On **timeout** (nobody answered / Pragma unavailable) it emits nothing and exits 0, so
   Claude Code falls back to its own native permission prompt. Never hangs a session.
   The native question/permission UI is rendered **concurrently** while the hook blocks,
   so a terminal answer during the wait also works — `PostToolUse` then restores
   `started`.

## Answering questions from a Pragma toast (`AskUserQuestion`)

Claude Code routes its interactive `AskUserQuestion` tool through the **same blocking
`PermissionRequest` hook** as command approvals. Without special-casing it, the question
surfaced as a `command` attention whose "command" was the raw tool JSON. The `permission`
case in `report.sh` therefore branches on `tool_name == "AskUserQuestion"`
(`handle_question`):

1. It parses the question text and answer choices from `tool_input.questions[0]` and
   reports `attention --kind question --question <text> --options <json> --request-id
<id>` — so Pragma clients render a real answer UI (radio options + free text), not a
   command-approval toast.
2. It blocks on `pragma-cli agent await-answer --request-id <id>` (same
   `PRAGMA_APPROVAL_TIMEOUT` budget), which unblocks when the app publishes the reply
   (an `AgentAnswer`).
3. It emits an **allow** decision whose `updatedInput` carries the reply in the tool's
   `answers` field, keyed by question text — the same shape Claude Code's own permission
   component uses to hand collected answers to the tool — so Claude continues with the
   answer and never shows its terminal question UI.
4. On **dismiss** it emits a **deny** decision so Claude closes the native question. On
   **timeout** it emits nothing and exits 0, so Claude falls back to its native prompt.
5. **Answer and dismiss both re-assert `started`** (marker-guarded) before the decision
   goes back — the turn resumes either way, and no later hook is guaranteed (a denied
   tool fires no `PostToolUse`), so without this the tab stayed stuck on the question
   attention ("does not update back to in progress").

**Multi-question payloads** (`AskUserQuestion` supports up to 4 questions) are reported
as a **generic** attention with no round-trip: one free-text reply can't answer them all,
so Claude's native UI collects those. Same story when `python3` is unavailable (the
parse helpers are python3-based, like the transcript helpers above).

**Interjections** (`AgentInput`, e.g. the SDK's `client.agents.connect(...).send(text)`) are
**not** handled by these hooks. They are delivered by the shared built-in-agent watcher
(`@pragma/opencode-plugin`'s `claudeCodeInterjectWatcher`, registered in
`apps/pragma/src/plugins/builtin-agents.ts`), which writes the text into the live terminal
followed by a submit key. These hooks stay status/approval-only.

`Elicitation` stays observe-only (`attention` dot, no decision).

**We deliberately do _not_ wire the `Notification permission_prompt`/`elicitation_dialog`
matchers.** That notification is debounced ~3–5s, and — critically — it fires _regardless
of how the prompt was resolved_. Wired alongside the fast hooks it produced phantom
attention both ways: after an **approval** it re-raised red over a turn that was already
running again, and after a **cancel** it re-raised red ~3–5s after the abort watcher had
cleared it, leaving the tab stuck red forever. Dropping it removes both races; the fast
hooks above cover every build that has them (current Claude Code). The marker guard on
`attention` (below) stays as defense-in-depth.

## Clearing `attention` after an approved prompt (`PostToolUse`)

`PermissionRequest`/`Elicitation` raise `attention`, but Claude Code fires **no hook when
the prompt is approved** — work simply resumes. Without a counter-signal the tab stays
stuck on the red "needs attention" dot for the entire tool run **plus** Claude's follow-up
response, only flipping back at `Stop`. That stale attention is the perceived lag between
"needs attention" and "in progress".

`PostToolUse` fires the moment the approved tool finishes, so we use it to re-assert
`running` (`report.sh running` → `pragma-cli agent report --agent claude-code started`), dropping the tab back to
"in progress" at once. It is **guarded on the turn marker** — a stray `PostToolUse`
outside a turn reports nothing — and deliberately leaves the marker and abort watcher
alone (same turn), so it re-asserts running on every tool without disturbing cancel
detection. Re-reporting `running` while already running is harmless: the daemon stores
status idempotently and only the transition the UI cares about (attention → running) is
visible.

`PermissionRequest` reports `attention --kind command` (with the command + a requestId for
the approval round-trip, see above). `Elicitation` reports a **generic** attention with no
`--kind` — MCP input gives no structured question-vs-command signal, so Pragma shows a
neutral "needs attention" indicator. (`--kind` is optional in `pragma-cli agent report`.)

**Both attention reports are guarded on the turn marker** (`[ -f "$marker" ]`). The fast
hooks always fire mid-turn so the marker is present and the guard
never suppresses a real prompt; it's defense-in-depth so a late or stray attention can't
land on an already-finished turn (which nothing would clear). It is also why we can drop
the debounced `Notification` fallback without leaving a hole: the actual clear path on a
**cancel** (ESC/decline) is the abort watcher below, which removes the marker and reports
`cleared` within ~1s; on an **approval** it's `PostToolUse` re-asserting `running`.

## Abort handling (the ESC problem)

**Claude Code emits no hook when a turn is cancelled.** This was verified empirically
against Claude Code 2.1.186 by driving a real PTY and logging _every_ hook event (all ~28
of them). For each of the three cancel paths the user cares about —

- aborting mid-response with ESC,
- rejecting a command's permission prompt (whether by "No" or ESC), and
- declining a question —

the turn ends and **zero** hooks fire: not `Stop`, not `StopFailure`, not `SessionEnd`.
Worse, the `Notification` `idle_prompt` event — which _does_ fire ~60s after a **normal**
completion — **never fires after a cancel** (confirmed by waiting >100s). So a purely
hook-driven bridge can never observe a cancel, and the tab stays stuck on
`running`/`attention` until the user's next prompt or quit. (An earlier design relied on a
`Stop` transcript check and the `idle_prompt` fallback; both are dead for real cancels.
The `Stop` transcript check is kept only as belt-and-suspenders for hypothetical builds
where `Stop` trails an interrupt.)

The cancel _is_, however, written to the session transcript **immediately**: the turn ends
with a trailing `user` message whose text is `[Request interrupted by user]` (or
`… for tool use`). Since no hook reports it, **we watch for it.**

The match (`interrupt_pattern`) is deliberately the **unescaped** JSONL form
`"text":"[Request interrupted by user`. The phrase merely _mentioned_ inside tool output —
e.g. Claude reading this very script into its context — is nested inside another JSON
string, so its quotes arrive backslash-escaped and never match. Grepping for the bare
phrase used to false-clear an active turn the moment `report.sh` itself was read.

### The background watcher

`started` (on `UserPromptSubmit`) spawns a detached background watcher
(`nohup sh "$0" __watch <transcript> <token> <offset> &`) that polls the transcript and,
the moment **this turn's** tail shows the interrupt marker, reports `cleared` and exits. A
hook-spawned `nohup` child outlives the hook invocation (verified), so this works even
though no hook fires at cancel time. Reset latency is the poll interval (~1s), not Claude
Code's ~60s idle delay.

**The watcher is pinned to a byte `offset`** — the transcript's size captured at `started`
— and only scans content written _after_ it (`tail -c +<offset>`, see `interrupted_since`).
This is essential: a previous cancelled turn leaves its interrupt marker as the file's last
line, so a plain `tail -n 5` would see it the instant the **next** turn starts — before
Claude appends anything — and false-clear a turn that is merely _thinking_ (the "no
in-progress status while thinking" bug). Scoping to the post-`started` tail makes a stale
marker invisible while still catching this turn's own cancel, which lands past the offset.
(The `stopped` path's belt-and-suspenders check still uses `tail -n 5`: it only runs when
`Stop` actually fired, i.e. a normal completion, so the stale-marker race can't reach it.)

Three per-tab files in `$TMPDIR` coordinate it, keyed on `PRAGMA_TAB_ID`:

- **`…-$TAB.active`** (the marker) — holds the **current turn's token** (`$$-<epoch>`).
  `started` writes a fresh token; `stopped`/`cleared`/(a marker-present) `idle` remove it.
  Presence = a turn is in flight; the token identifies _which_ turn.
- **`…-$TAB.watcher`** (the pidfile) — the running watcher's pid, so a new turn or a normal
  end can tear it down (`stop_watcher`).
- **`…-$TAB.turn-session`** — the session id that owns the in-flight marker. `/clear`
  fires `SessionEnd` (old session) + `SessionStart` (new session) as **concurrent hook
  processes** while the user's next prompt may already have started a turn in the new
  session. Session pinning discards the old session's late `SessionEnd`, but
  `SessionStart` re-pins to its own id first — so a `SessionStart` landing _after_ that
  session's first `started` would wipe the live marker and **mute every marker-guarded
  report for the rest of the turn** ("reports stop coming through after `/clear`"). The
  `cleared` case therefore skips clearing when the in-flight turn already belongs to the
  same session the `SessionStart` announces.

The watcher exits without touching state if the marker is **gone** (normal end / session
end) or its **token changed** (a new turn started), so it can never clear a turn it no
longer owns — it re-checks the token right before reporting `cleared` to close the race
where a new turn starts mid-poll. A new `started` also kills the prior watcher outright, so
there is at most one watcher per tab. An absolute `PRAGMA_WATCH_MAX` (default 24h) backstop
guarantees a watcher can't orphan forever if the session is `SIGKILL`ed and never removes
its marker; `SessionStart` also sweeps any stale watcher.

This mirrors opencode's "cancelled turn → clear, not a phantom `done`" rule (see
`packages/opencode-plugin/src/hooks.ts`) — opencode gets a `session.error`
(`MessageAbortedError`) event for free; Claude Code gives us nothing, so we poll the
transcript instead. `PRAGMA_WATCH_INTERVAL` (default `1`, set small in tests) tunes the
poll cadence.

## Installation

Through Claude Code's own plugin system — **not** Pragma code:

```bash
claude plugin marketplace add <path-to-packages/claude-code-plugin>
claude plugin install pragma-claude-code@pragma
```

This registers it at **user scope** so it runs in every Claude session, including
outside Pragma.

## Usage limits

The Pragma plugin sends Claude Code's structured `get_usage` control request through a
short-lived `claude -p --safe-mode` process. This is the same normalized plan-limit data
used by `/usage`: the five-hour window, weekly window, and optional app/model windows.
Claude Code owns Keychain/Linux credential reads, OAuth refresh, and the private
`GET /api/oauth/usage` call; Pragma never reads or transports an access token. Keep this
route instead of duplicating Claude's credential storage or refresh protocol.

Gotcha: when that usage endpoint rate-limits the CLI (it 429s easily under polling), the
`get_usage` reply still says `rate_limits_available: true` but carries `rate_limits: null`
even while signed in. Treat that as a transient failure (**throw**, so the host keeps its
last snapshot and backs off) — never as `authentication-required`, or the indicator shows
"signed out" for authenticated users. This is also why `refreshIntervalMs` is 5 minutes:
each refresh spawns a fresh headless session that hits the endpoint.

Claude Code runs the cached plugin copy shown by `claude plugin list --json`, not the
marketplace source directory directly. After changing this package, refresh the local
marketplace and reinstall the plugin before testing; an already-running Claude session
must also restart to load the new hooks.

## Guard + non-Pragma sessions

`report.sh` exits 0 immediately when `PRAGMA_DAEMON_SOCKET` is unset, so the plugin
silently no-ops in every non-Pragma Claude session (it's installed at user scope, so it
runs everywhere). Inside Pragma the terminal injects `PRAGMA_DAEMON_SOCKET`,
`PRAGMA_TAB_ID`, and `PRAGMA_WORKTREE_ID`; `report.sh` keys its marker on
`PRAGMA_TAB_ID`, and `pragma-cli` (installed by the app on startup) reads all three.
Pragma sessions also export `PRAGMA_CLI=$HOME/.local/bin/pragma-cli`; `report.sh` uses
that absolute path before falling back to `pragma-cli` from `PATH`. Every call is wrapped
`… >/dev/null 2>&1 || true` so a missing CLI or down daemon can never disrupt a Claude
session.

## Built-in launcher

The launchable Claude Code entry is defined **here** in `src/pragma-agent.ts`; it starts
`claude --permission-mode auto`. This is now the single source of truth: the
`pragma-plugins` catalog sidecar (`@pragma/plugins-host`) imports it directly to assemble
the agent catalog, and `apps/pragma/src/plugins/builtin-agents.ts` re-exports it
(overriding `iconPath` with a browser URL and attaching the built-in watcher) so the
webview path shares the same definition. Its icon asset stays in this package under
`assets/`, not in Pragma core.
Claude Code supports `--model` and `--effort` but does not expose a supported model-list
command, so the built-in agent uses static model metadata. Reasoning efforts are listed
per model and are appended as `--effort {reasoning}` when selected; choosing a model with
Auto reasoning appends only `--model`. If Claude Code changes its supported surface,
prefer an official CLI/API model-list command before using private databases or internal
caches.

## Known gotchas

1. **Do not set `hooks` in `plugin.json`.** Claude auto-loads the standard
   `hooks/hooks.json`, and _also_ declaring it in `plugin.json` fails with "Duplicate
   hooks file detected". The manifest `hooks` field is only for _additional_ hook files.
2. Installed at user scope, the plugin runs in **every Claude session**, including
   outside Pragma — hence the `PRAGMA_DAEMON_SOCKET` guard on every hook.
