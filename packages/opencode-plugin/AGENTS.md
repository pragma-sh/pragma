# packages/opencode-plugin — @pragma/opencode-plugin

ESM opencode plugin that reports agent status into Pragma. Built with Bunup
(ESM-only). Imports opencode plugin types from `@opencode-ai/plugin`, reacts to
opencode hooks/events, and reports `started` / `stopped` / `attention` / `cleared` /
`session-name` (the parent session's title from `session.created`/`session.updated`,
deduplicated, so Pragma renames the hosting tab on create/rename/switch)
through `@pragma/sdk`.

## File map

```
packages/opencode-plugin/
├── assets/                 # OpenCode brand assets used by the built-in launcher
├── src/
│   ├── index.ts             # PragmaOpencodePlugin entry point
│   ├── hooks.ts             # Two-flag state machine (busy + attention)
│   ├── pragma-plugin.ts     # Agent + watcher definition loaded by plugin sidecars
│   └── usage-limits.ts      # OpenCode Go local cost-window aggregation
└── dist/
    ├── index.mjs            # opencode status plugin (Bunup; git-ignored)
    └── pragma-plugin.mjs    # Agent/watcher bundle
```

The status plugin (`dist/index.mjs`) is registered in **opencode's own** `plugin` config
(see _Installation_). Agent and watcher contributions share `dist/pragma-plugin.mjs`;
`stage-daemon-sidecar.sh` stages it into app resources, and plugin sidecars import it for
catalog and live watcher behavior.

## Installation

**Pragma no longer auto-installs the opencode plugin** — the old
`src-tauri/src/opencode_plugin.rs` installer was removed. To use it, register the built
`packages/opencode-plugin/dist/index.mjs` absolute path in the `plugin` array of
`~/.config/opencode/opencode.json` yourself.

**opencode does NOT auto-load plugins from any directory** (verified against opencode
1.17.8). Only a `plugin`-array entry loads a plugin. A **file path / `file://` URL**
entry loads fine and is **not** npm-resolved; only a **bare package name**
`@pragma/opencode-plugin` is treated as an npm dependency (opencode tries to fetch it
from the registry, where it does not exist) — never register it by name.

## State machine (hooks.ts)

`hooks.ts` is a **two-flag state machine** (`busy`, `attention`) rather than a
per-event mapping. The reported status is _derived_ (`attention` > `busy` > idle) and
emitted only on change.

Status sends are serialized through one promise queue. OpenCode can invoke adjacent
event hooks concurrently; without serialization, a slow `started` HTTP request from an
earlier turn could arrive after its `stopped` request and leave the tab incorrectly busy.

Only root sessions feed normal status and transcript handling. `session.created` /
`session.updated` events identify subagent sessions by `info.parentID`; child lifecycle
is tracked separately so a parent idle cannot report finished while any of its children
remain active. Child classification survives partial `session.updated` payloads that omit
`parentID`, and only the parent's final idle after all children finish reports stopped.

**`busy` is set by:**

- `chat.message`, `command.execute.before`, non-question `tool.execute.before`,
  `session.status` busy/retry

**`busy` is cleared by:**

- `session.idle`, `session.status` idle, a non-abort `session.error`, `session.deleted`

**Chat content (mobile/desktop transcript):**

- `chat.message` reports a **user** `AgentMessage` — text comes from the hook's
  `output.parts` (text parts), not the input metadata (which has no prompt body).
- `message.updated` remembers each message's `role` by id.
- `message.part.delta` accumulates assistant text and reports each growing snapshot;
  `message.part.updated` reconciles it with the latest full text. Both use an upserted
  `AgentMessage` (`id: assistant:<messageID>`) so streaming updates replace the same
  bubble. User text parts are ignored here (already reported via `chat.message`).
- OpenCode `reasoning` parts use separate stable IDs and the `system` role, so clients
  render thinking as muted activity instead of a standard assistant bubble.

**`stopped` (green "done") is only emitted after a `started`** — a bare `session.idle`
or an idle trailing an aborted/cleared turn must not resurrect a phantom "done" dot.

**An aborted turn** (esc-esc / `session.abort`) surfaces as `session.error` carrying
`MessageAbortedError` and reports `cleared`, not `stopped`.

**`server.instance.disposed` reports `cleared`** — opencode quitting clears the dot
even when the `dispose` plugin hook doesn't run (abrupt shutdown).

**`attention` is raised by:**

- The `permission.asked` event → a **`command` attention carrying the command text + a
  requestId** (see _Command approval_), and the `question` tool (via `tool.execute.before`
  or, on OpenCode 1.18+, the canonical `question.asked` event) → a **`question` attention carrying the
  prompt + option labels/descriptions + a requestId**. Question args live on
  `question.asked.properties.questions[]` in OpenCode 1.18 and on the legacy hook's second
  parameter (`output.args.questions[]`); the plugin parses `question`/`header` and
  each option's `label`/optional `description` so mobile/desktop can render a real answer UI instead of raw
  JSON. Non-question tool summaries prefer the primary arg (command, path, pattern)
  over `JSON.stringify(args)`.

**`attention` is cleared by:**

- `permission.replied` or the question part completing/erroring

**Permission events — verified empirically:** the runtime emits `permission.asked` /
`permission.replied` (NOT the `permission.updated` the TS `Event` union declares), and
it **never calls the `permission.ask` plugin hook** (absent from the binary). The plugin
`event` hook does receive `permission.asked`, which is why event-based detection works.
The `permission.ask` hook + `permission.updated` event are kept as harmless cross-version
fallbacks (both routed to the same command-approval report). Only real opencode events are
handled — **do not re-add the speculative `session.next.*` events** (opencode does emit
`session.next.agent.switched` / `session.next.model.switched`, but they carry no status
meaning; mapping them was the source of the stuck-yellow bug).

OpenCode 1.18 adds `question.asked` / `question.replied` / `question.rejected`. Prefer
`question.asked`: it carries complete prompt/options plus stable request id, while the
earlier `message.part.updated` event can contain an incomplete tool state. Never emit a
generic question attention for that incomplete state; it can race ahead of canonical data.
Legacy question-hook reports are deferred briefly so this canonical event can supersede
their synthetic call id. Otherwise a fast remote answer targets the legacy id immediately
before OpenCode raises its real `que_*` prompt, leaving the session stuck on attention.

## Command approval + question answers (the watcher route)

Unlike Claude Code / Cursor, opencode's `permission.ask` hook — the only one that can
**return** an allow/deny decision — is absent from the verified binary, so approval cannot
go through a blocking hook. The question tool is the same shape: the in-process plugin can
_report_ a pending question, but completing it requires either the OpenCode TUI or an HTTP
`question.reply`. Remote mobile/desktop answers therefore go the **watcher** route too —
split across two pieces:

1. **In-process (this plugin):** on `permission.asked`, report
   `attention --kind command --command <cmd> --request-id <id>` (requestId is a fresh uuid).
   `<cmd>` is extracted best-effort by `commandFromPermission`: the shell command for a
   `bash` permission (including nested `metadata.input.command` / argv arrays), or
   `<verb> <filePath>` (Read/Write/Edit) for a file tool, falling back to
   title/pattern/type and finally a generic label. It normalizes the varying payload
   nesting (`.properties`, `.properties.permission`, or the permission directly) first.
   This raises the
   Pragma **approval toast** with the command + Approve/Deny — the same toast Claude/Cursor
   use. The report **owns** the command attention, so `permission.asked`/`permission.updated`
   no longer emit a separate generic attention (that would double-toast).

   For the `question` tool, `tool.execute.before` / a pending `message.part.updated` part
   reports `attention --kind question --question <prompt> --options <labels> --request-id
<id>` (requestId is `opencode-question-<callID>` when known). That drives the mobile
   AttentionDock / Inbox answer UI.

2. **Host-side (`pragma-plugin.ts`):** the shared TUI watcher declaration, loaded by
   the `pragma-watch` sidecar for a launched session. Each watcher `connect`s a duplex agent
   channel scoped to **its** agent + tab (`ctx.sdk.agents.connect({ agent: ctx.agentId, ... })`)
   and drives the live terminal from it:
   - **Interjections** (`AgentInput`) are typed into the terminal followed by a submit key
     (default `\r`). Claude Code receives text and submit as separate writes with a short
     delay; a single PTY burst is treated as pasted multiline input and leaves the prompt
     staged instead of submitting. OpenCode and Cursor use one combined write.
   - **Command verdicts** (`AgentDecision`) and **question replies** (`AgentAnswer`) are
     answered with keystrokes **only for opencode** (`opencodeApprovalWatcher`,
     `handleDecisions: true`) — its permission / question prompts have no decision-returning
     hook. Claude Code / Cursor answer approvals through their blocking `await-decision` hook,
     so `claudeCodeInterjectWatcher` / `cursorInterjectWatcher` are interject-only and never
     touch verdicts.

   The connection is already filtered to the watcher's agent + tab, so no per-event scope
   check is needed. The agent event stream is a long-lived HTTP response that can drop while
   the agent keeps running, so the watcher **re-connects** (short backoff) until its session
   aborts — a single dropped stream must not silently disable approval or interjection — and a
   failed `sendKeys` write is swallowed rather than tearing the watcher down. The server
   replays recent attention and decision events to cover watcher startup races; the watcher
   caches command-attention request ids, ignores unmatched verdicts, and dedupes matched verdicts
   so a wrong id or reconnect replay cannot operate the live prompt. opencode's permission
   prompt has **three** options with "Allow" selected first: **approve** = Enter (`\r`);
   **reject** = two Right-arrow presses then Enter (`\x1b[C\x1b[C\r`) to move to the third
   ("Reject") option and confirm. Override via the watcher's `approveKeys` / `denyKeys` /
   `submitKeys` config if the TUI layout changes.

   **Question answers** cache the latest `question` attention's option labels (by
   `requestId`), then on `AgentAnswer` write OpenCode's question-TUI keystrokes: digits
   `1`–`9` select+submit a listed option; an unmatched reply opens the virtual "Type your
   own answer" row (`options.length + 1`), types the text, and Enter-submits; dismiss /
   empty reply sends Escape. The shared watcher waits briefly after the attention report
   before writing any answer keys because OpenCode can emit `question.asked` just before
   its TUI prompt mounts, especially during parallel verification. Helper:
   `questionAnswerKeys`.

Each built-in plugin declares its watcher in `src/pragma-plugin.ts`. The catalog sidecar
reports matching bundle metadata to server, which starts `pragma-watch` for a headless
launch. opencode approval/question answering additionally requires opencode status plugin
(installed in opencode); interjection works for any watcher-backed built-in agent.

**`dispose` (agent process exiting) reports `cleared`**, not `stopped` — quitting
opencode removes the indicator; finishing a turn (`session.idle`) still reports `done`.

**On load (`PragmaOpencodePlugin` in `index.ts`) the plugin fires one `cleared` up
front** so opening opencode never inherits a stale indicator from a previous run in the
same tab that exited without cleanup (`dispose` only runs on a graceful quit; a crash
leaves the last status lingering in the long-lived daemon).

Reporting uses the fetch-based `@pragma/sdk` gateway helpers. Plugin options no longer
accept `executable` or `cwd`; the SDK no-ops through `hasPragmaEnvironment()` unless
`PRAGMA_GATEWAY_URL`, `PRAGMA_GATEWAY_TOKEN`, `PRAGMA_TAB_ID`, and
`PRAGMA_WORKTREE_ID` are present.

## Built-in launcher

The launchable OpenCode entry is defined **here** in `src/pragma-plugin.ts` — this is now
the single source of truth. The `pragma-plugins` catalog sidecar imports its built bundle
to assemble agent catalog and watcher metadata. Its icon asset stays in this package
under `assets/`, not in Pragma core.

`prefillDelayMs` is set higher than the core default because opencode's TUI can take
longer to mount its input in a background PTY before prompt paste/submit is reliable.

The built-in model provider owns all opencode-specific parsing. It tries supported
opencode model-list surfaces (`opencode models --json`, then `--verbose`, then plain
`opencode models`) and returns Pragma's generic model entries. Each model's display name
gets its provider appended in parentheses (e.g. `Claude Sonnet 4 (anthropic)`), derived
from the `provider` field or the `provider/model` id prefix. Fast variants stay separate
model entries when opencode exposes separate IDs. Reasoning is omitted unless opencode
exposes reliable per-model reasoning levels.

OpenCode Go usage comes from the supported `opencode db <query> --format json` command.
The provider sums assistant-message costs whose provider is `opencode-go` against Go's
documented $12/5-hour, $30/week, and $60/month limits. The 5-hour reset follows the first
local message in the active rolling window; weekly reset is Monday UTC; monthly reset is
the next UTC calendar month because OpenCode's local database does not expose the account's
subscription anchor.

This source is device-local. Requests from other devices or agents do not appear, so the
provider can undercount account-wide usage. Do not read browser cookies or OpenCode's raw
credential file to improve it; switch to an OpenCode-owned authenticated usage endpoint if
one becomes available. A machine with no local `opencode-go` messages reports `unsupported`,
and transport or parser failures throw so `agent verify` detects regressions.
