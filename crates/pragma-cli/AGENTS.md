# crates/pragma-cli - pragma-cli

CLI for Pragma host/client utilities and external agent status reporting. The
binary name is `pragma-cli` (not bare `pragma`, which collides with the app
crate's debug binary).

## Current Usage

```sh
pragma-cli scratchpad create --title "Architecture" result.mdx
pragma-cli whiteboard create --title "Architecture" scene.excalidraw
pragma-cli whiteboard search "auth flow"
pragma-cli whiteboard view <id> architecture.png
pragma-cli agent report --agent <id> started|stopped|attention|cleared
# Session name: status-less report that renames the hosting tab (user renames win).
pragma-cli agent report --agent <id> session-name --name "<name>"
# Harness session id: status-less report of the conversation id a resume continues.
pragma-cli agent report --agent <id> session-id --id "<harness-session-id>"
# Or forget it (new/unmaterialized session, deleted conversation): --clear instead of --id.
pragma-cli agent report --agent <id> session-id --clear
# Supervise one host-prepared invocation (written into the tab by prepareAgentLaunch).
pragma-cli agent run --run-id <id> -- <argv...>
# Command approval: report the command + a correlation id, then block for the verdict.
pragma-cli agent report --agent <id> attention --kind command --command "<cmd>" --request-id <id>
pragma-cli agent await-decision --agent <id> --request-id <id> [--timeout 300]
pragma-cli agent decide --agent <id> --request-id <id> --allow|--deny
# Question/answer: report the question (+ optional JSON answer choices) + a
# correlation id, then block for the reply.
pragma-cli agent report --agent <id> attention --kind question --question "<q>" \
  --options '[{"label":"Yes","description":"..."},{"label":"No"}]' --request-id <id>
pragma-cli agent await-answer --agent <id> --request-id <id> [--timeout 300]
pragma-cli agent answer --agent <id> --request-id <id> --text "<reply>"|--dismiss
# Interject: publish free-form input to a running agent (the controlling-client side).
pragma-cli agent input --agent <id> --text "<message>" [--request-id <id>]
# Launch through the gateway (desktop open: a tab; `--headless` or app closed: host-owned).
pragma-cli agent start --agent <id> [--model <id> [--reasoning <id>]] [--mode <id>] \
  [--permission-mode <id>] [--slash-command <name>] [--prompt "<text>"] [--headless]
# What an agent can start with: models, modes, permission modes, slash commands.
pragma-cli agent options --agent <id>
# End-to-end integration verification through the gateway/mobile API surface.
pragma-cli agent verify --agent <id> [--scenario <id>] [--abort-input '\x1b'] \
  [--model <id> | --pick-model-cmd "<raw model args>"] [--jobs <n>] [--headed]
```

`scratchpad create` reads an MDX file (or `-` for stdin), writes a managed document under
the current worktree's `.pragma/scratchpads/`, attaches `$PRAGMA_TAB_ID`, and opens a
scratchpad tab. It requires the current tab to be a registered agent tab and the desktop
controller to be connected. Scratchpad frontmatter is created by this command; agents do
not write managed files directly.

`whiteboard` talks directly to `pragma-server`. Scenes are full Excalidraw JSON from a file
or stdin; preserve unknown fields. `delete` confirms unless `--yes`, and `view` writes
native-rendered PNG bytes to requested path.

`agent await-decision` blocks on the agent event stream until a Pragma approval toast
publishes the matching `AgentDecision`, then prints `allow`/`deny` (exit 0). On timeout it
prints nothing and exits non-zero so a blocking harness hook (Claude Code
`PermissionRequest`, Cursor `beforeShellExecution`) can fall back to its native prompt.
`agent decide` is the controlling-client side: it publishes that verdict.

`agent await-answer` mirrors this for questions: it blocks until the matching `AgentAnswer`
arrives, then prints the reply text (exit 0). A dismissed reply or timeout prints nothing
and exits non-zero so the caller can fall back. Hooks that must distinguish dismissal from
timeout can pass `--dismiss-output <value>`; dismissal then prints that value and exits 0.
`agent answer` publishes the reply (`--text`) or a dismissal (`--dismiss`).

`agent input` publishes an `AgentInput` (a free-form interjection) fanned out to agent
subscribers; the waiting reporter — a harness input hook or a plugin watcher — delivers the
text into the running agent's turn. It is fire-and-forget (no verdict to wait for) and is the
CLI side of the SDK's `client.agents.connect(...).send(text)`.

`agent report --agent <id> session-id --id <harness-session-id>` is the status-less report
that stores the harness's own conversation id (Claude Code's session id, opencode's session
id) so a crash/update resume continues the latest conversation; report it again whenever
the harness switches sessions. Every report reads `PRAGMA_AGENT_RUN_ID` and carries it as
`agentRunId`, so the host can attribute the id to the exact tracked run and reject a stale
report from a superseded one. `session-id` is deliberately distinct from `session-name`:
one stores the resume pointer, the other renames the tab.

`session-id --clear` (mutually exclusive with `--id`, exactly one required) sends
`clearHarnessSessionId: true` instead: the harness started a new, not-yet-materialized
session (Pi) or the selected conversation was deleted (OpenCode), so the stored id must be
forgotten and nothing may auto-resume it. Clearing wins over an id in the same report, is
scoped to the run the report carries (`agentRunId`), and a stale run's clear cannot touch a
newer one.

`agent run --run-id <id> -- <argv…>` is the supervisor a tracked launch runs under (the
host wraps a resume-capable agent's argv with it in `prepareAgentLaunch`); it is not meant
to be run by hand. It inherits the terminal (the child owns stdin/stdout/stderr), sets
`PRAGMA_AGENT_RUN_ID` in the child's environment, and exits with the child's code.

Its host protocol is strict in three places. **The host must authorize the start before
the child exists**: `startRun` has to succeed (a stale, closed, or session-less run id is
rejected) or the child is never executed and the failure is surfaced. That reply also
carries `env`, resolved from the record's saved account references; the wrapper applies it
to the child directly, so the execution runs under the account the launch was prepared
with even if the shell's spawn-time env timed out or a binding moved. The reply also
carries the authorizing `serverBootId`, which the wrapper echoes on `finishRun`: a
previous boot's late end report is rejected as stale instead of ending the record the
restarted host is about to resume. **`finishRun` after the child's real exit is the only
end signal** — never a cleared status or a watcher exiting. And **only an ordinary (code) exit is journaled, before the finish report is
attempted**: the wrapper writes `agent-completions/<run-id>` (exit code as text,
temp+rename, synced) first, so a host that dies mid-retry still sees the end. A signal
death is deliberately never journaled — SIGHUP is what a killed host's terminal hangup
delivers, and journaling it would suppress the recovery that should happen — and the
wrapper exits with `128 + signal` so the cause reaches the shell. The server replays the
journal before reconciling interrupted runs, and again immediately before a restore
rotates an execution.

On Unix it catches SIGINT/SIGTERM/SIGHUP so a Ctrl-C aimed at the agent's process group
cannot kill the supervisor before it reports the exit; the child keeps default
dispositions, so the TUI still receives Ctrl-C. Lifecycle reports are timeout-bounded and
retry transient failures briefly; a stale run id is final and never retried.

`agent verify` discovers the local gateway, launches fresh real-agent sessions from the
plugin catalog, drives question/decision/abort scenarios over HTTP, and strictly parses
the same NDJSON event stream mobile consumes. Events are scoped by the RUNTIME agent id
(final segment of the catalog id), exactly like mobile's stream filter — a plugin
reporting under the qualified catalog id fails verification because those consumers
would never see it. It runs all scenarios by default, retries
LLM-dependent behavior with fresh sessions, and exits non-zero on any failure.
Scenario sessions launch **headlessly by default** (launch payload `headless: true`), so
the server spawns them without opening a desktop tab even while the app is connected;
`--headed` restores brokering through the desktop launch path. Scenarios run
**concurrently** on a worker pool (`--jobs`, default 6, max 16). Failure evidence is
scoped to each scenario's own launched tabs, and `stream-integrity` always runs alone
after the pool drains because it asserts invariants over the whole event ledger.
`--fail-fast` stops scheduling new scenarios after a failure but lets in-flight ones
finish. `--step-timeout` is one total budget per fresh-session attempt, shared by every
wait within that attempt. A retry gets a fresh budget instead of inheriting the first
attempt's expired deadline. Each headless launch
immediately probes its terminal with an empty write, surfacing server/session failures
before any event timeout. `await_running` waits at most 20s: if no running report lands, the
prompt prefill likely raced the TUI boot and was swallowed, so the session retypes the
prompt once (mirroring the catalog's prefill mode/submit) and waits out the remaining
budget. It never sends more than one retry because delayed status reporting must not
create duplicate turns. Waits for
attention, assistant messages, session names, and sub-agent activity **fail fast on
settle**: after a done/cleared status only a 10s grace window remains for the awaited
event to ride in (stop-hook reporters emit late events; a new running status re-opens
the window for follow-up turns), so an agent that finishes its turn without the expected
event fails with `agent settled without ...` instead of burning the whole step timeout.
Question
scenarios validate exact prompt/options, listed and custom answers, dismissal, and wrong
request-id isolation rather than accepting any generic question attention.
Behaviorally similar scenarios use distinct prompts; repeated identical questions and
artificial busywork can make models refuse later cases instead of exercising the host.
Abort-mid-question waits one short render window after attention before injecting Escape;
host reporters can publish the question immediately before their TUI prompt mounts, and
an earlier abort byte is nondeterministically swallowed under parallel startup load.
Stream-integrity message and attention invariants are scoped to that runtime agent so
unrelated agents reporting concurrently cannot fail the selected integration.
Before exiting, verification explicitly reports `cleared` for every session it launched,
including failed attempts, so timeout and attention scenarios leave no stale status dots.
`crash-exit` kills the launched session and waits for its status to settle; the host
server broadcasts `cleared` for a tab's agent statuses when its session is killed or
exits on its own (a SIGKILLed agent's own hooks never run), so the scenario passes for
every agent, not just those whose plugin can report its own death.
Agent catalog `excludeFeatures` entries skip matching optional scenario groups with an
explicit reason. The catalog gate also fails a mode or permission mode without resolved
launch args (a plugin that declares `modes` but no `args.mode`). `slash-commands` checks
the catalog lists well-formed slash commands; it and `catalog` launch nothing, so
`--scenario slash-commands` alone needs no worktree, workspace, or event stream. `command-no-permission` verifies a safe shell command completes and
raises no command-attention event; command approval remains a separate capability group.
Approval scenarios request an explicit external `workdir` rather than putting `$HOME` in
the command: OpenCode 1.18 treats command-argument external paths as advisory and cannot
resolve shell environment expansion when deciding whether approval is required.
`question-free-text` requires an assistant message echoing the exact marker returned
through the native TUI custom-answer editor. Watchers must not abort the response and
resubmit the answer as a follow-up prompt.

`--pick-model-cmd` (mutually exclusive with `--model`) sends the raw snippet as the
launch payload's `modelCmd` instead of a catalog `modelId`: the headless server appends
it to the agent's base catalog launch command, and a connected desktop appends it (split
on whitespace) in place of the plugin's model/reasoning arg builders. Use it for models
the catalog does not list — for example the cheapest subagent-capable model, to save
tokens during verification.

`pragma-cli agent start` is brokered through the app but is not supported for
plugin-defined agents; launch agents from the Pragma UI so the frontend can run JS
plugin model/argument builders.

Every command renders plain text (aligned tables / short human lines) by
default. Two mutually exclusive global flags switch to structured output for
scripting:

- `--json` — `serde_json`-serialized output.
- `--toon` — [TOON](https://toonformat.dev) (Token-Oriented Object Notation)
  output via the `toon-format` crate, a token-efficient JSON alternative
  meant for LLM contexts (e.g. piping `pragma-cli tab list --all --toon`
  into an agent prompt instead of `--json`).

Both go through `crate::output::Output`, which serializes the same
`serde_json::Value`/`Serialize` payload either as JSON or, for `--toon`, by
converting it to a `serde_json::Value` and encoding that with
`toon_format::encode_default`.

| Status      | Dot color | Meaning                          |
| ----------- | --------- | -------------------------------- |
| `started`   | yellow    | Agent is running                 |
| `stopped`   | green     | Finished - go look at the output |
| `attention` | red       | Needs input / permission         |
| `cleared`   | -         | Remove the indicator entirely    |

`cleared` is distinct from `stopped`: use it when an agent exits without a
meaningful result to show.

## Fanout

`pragma-cli fanout` talks **directly to `pragma-server`**, never through the
desktop broker: a fanout started from an agent's own terminal behaves the same
whether Pragma is running or not.

```sh
pragma-cli fanout create "Implement token refresh and tests" \
  --reasoning high --agent opencode --agent claude-code
pragma-cli fanout show [<id>] [--watch]
pragma-cli fanout read [<id>] --all --lines 100
pragma-cli fanout send [<id>] --all --message "Also include migration docs"
pragma-cli fanout retry [<id>] --member <member-id>
pragma-cli fanout cancel [<id>]
pragma-cli fanout pick [<id>] --member <member-id>   # destructive; --yes to skip the prompt
```

There is deliberately **no `fanout list`**: a parent owns at most one active
fanout, so an omitted id resolves from `$PRAGMA_FANOUT_ID`, then from the
current worktree (as a parent or as an attempt). `--member` defaults to
`$PRAGMA_FANOUT_MEMBER_ID`, which every attempt session exports.

The CLI only supplies defaults — the request that leaves is the same one
`@pragma-sh/sdk` sends. `create` exits non-zero on a partial provisioning while
still printing the persisted members, and `pick` requires a typed `yes` (or
`--yes`) after printing every worktree, branch, and session it will delete.

## How It Works

The CLI reads `PRAGMA_SERVER_SOCKET` first, falling back to the legacy
`PRAGMA_DAEMON_SOCKET` during the transition. It also reads `PRAGMA_TAB_ID` and
`PRAGMA_WORKTREE_ID`, connects to the existing `pragma-server` Unix socket,
reads the `Hello` frame, writes one `AgentReport` frame, and exits after the
frame is sent. `agent run` uses the same connection setup but speaks the `tabs`
RPC (`startRun`/`finishRun`) around the supervised child.

## Staging

The built binary is staged to
`apps/pragma/src-tauri/binaries/pragma-cli-<triple>` by
`apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh` and bundled as a Tauri
sidecar. The app installs/updates it to `~/.local/bin/pragma-cli` on startup.

## Future Scope

Most GUI-required commands broker through the running app via `pragma-server`.
Commands that do not need the app (`tab read`, `agent status`, and
`agent report`) talk directly to the server.

Computer tasks: `computer run <instruction> [--app] [--request-id] [--detach]`, `resume <task-id>`, `status <task-id> [--wait]`, and `cancel <task-id>` are direct host RPCs. Inputs are repeatable name=value pairs or JSON `{inputs,secrets}` from `--inputs-json <file-or->`; prefer stdin for secrets. Run waits by default, but a killed CLI only disconnects. A task result is returned as structured state, distinct from an RPC failure; inspect `status`, `code` and `resumable`. `end` cancels unfinished work and releases leases.

Human task output must show the reason/code for failures and **Waiting for input** for
`needsInput`, including the question, required names/options, and a resume command.
Keep JSON/TOON payloads unchanged. Suggested commands use placeholders, never supplied
values; secrets and names with shell syntax use the stdin JSON handoff.

When verifying a freshly built CLI directly, unset `PRAGMA_CLI`: `session_cli.rs`
otherwise delegates even an explicit `target/debug/pragma-cli` path to that session's
installed binary. Set `PRAGMA_SERVER_SOCKET` explicitly for the intended dev channel.

Desktop pause/takeover returns `paused` immediately from task waits and asks the user to Resume in Pragma before `computer resume`. Desktop Stop cancels the task and requires the user's Restart followed by a new run. Do not hide either outcome behind an automatic retry.
