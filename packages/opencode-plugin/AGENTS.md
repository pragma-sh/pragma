# packages/opencode-plugin — @pragma-sh/opencode-plugin

ESM opencode plugin that reports agent status into Pragma, for both OpenCode plugin
APIs: v1 (`@opencode-ai/plugin`, `src/index.ts`) and v2 (`@opencode/plugin`, `src/v2/`).
It reacts to opencode hooks/events and reports `started` / `stopped` / `attention` / `cleared` /
`session-name` (the parent session's title from `session.created`/`session.updated`,
deduplicated, so Pragma renames the hosting tab on create/rename/switch) and
`session-id` (the current top-level conversation id, so Pragma can resume it)
through `@pragma-sh/sdk`.

## File map

```
packages/opencode-plugin/
├── assets/                 # OpenCode brand assets used by plugin launcher
├── src/
│   ├── index.ts             # PragmaOpencodePlugin entry point (OpenCode v1 API)
│   ├── v2/
│   │   ├── index.ts         # PragmaOpencodeV2Plugin: no-op v2 server entry (required by the loader)
│   │   ├── tui.ts           # PragmaOpencodeTuiPlugin: v2 TUI entry that reports status
│   │   ├── session-statuses.ts # One state machine per root session, folded into the tab's status
│   │   ├── id.ts            # Shared v2 plugin id
│   │   └── events.ts        # v2 `{ type, data }` events → v1-shaped runtime events
│   ├── hooks.ts             # Two-flag state machine (busy + attention), shared by both APIs
│   ├── reporter.ts          # Pragma SDK reporter + plugin options, shared by both APIs
│   ├── pragma-plugin.ts     # Agent + watcher + account definitions loaded by plugin sidecars
│   ├── accounts.ts          # openCodeStoreAccount: v1 auth.json swap / v2 credential binding
│   ├── opencode-version.ts  # isOpenCodeV2 (cached `opencode --version`)
│   ├── opencode-api.ts      # `opencode api` calls into the v2 background service
│   ├── host-shell.ts        # Host-shell quoting + `opencode` existence check (POSIX / PowerShell)
│   └── usage-limits.ts      # OpenCode Go cost windows (v1 `opencode db`, v2 session stats)
└── dist/
    ├── index.mjs            # v1 status plugin (git-ignored)
    ├── v2/                  # v2 plugin dir: index.mjs (server) + tui.mjs + package.json (git-ignored)
    └── pragma-plugin.mjs    # Agent/watcher bundle
```

The status plugin (`dist/index.mjs`) is registered in **opencode's own** `plugin` config
(see _Installation_). Agent and watcher contributions share `dist/pragma-plugin.mjs`;
`stage-daemon-sidecar.sh` stages it into app resources, and plugin sidecars import it for
catalog and live watcher behavior.

## OpenCode v2

OpenCode v2 replaced the plugin API: a v1 plugin never runs under v2, and v2 reads the
`plugins` config key (v1 reads `plugin`).

**v2 status reporting runs in the TUI, never the server.** v2 server plugins load inside
the shared `opencode serve --service` daemon: one process for every tab on the machine,
started once (often by launchd, parent pid 1) and long outliving any tab. It has no
`PRAGMA_TAB_ID` / gateway env, so a server-side reporter silently drops every report —
and if a Pragma tab happened to start the service, it would report every tab's agent into
that one tab. The TUI (`opencode` in the tab) is the process Pragma launched, so its env
is right. A plugin directory therefore ships two entries:

- `src/v2/index.ts` → `dist/v2/index.mjs`, the **server** entry. OpenCode refuses a
  directory without one (`Plugin entrypoint not found`) and only finds the sibling TUI
  entry through it. It deliberately does nothing.
- `src/v2/tui.ts` → `dist/v2/tui.mjs`, the **TUI** entry (OpenCode probes `<dir>/tui`).
  It imports `define` from `@opencode/plugin/tui/plugin` (the `tui` root pulls in Solid),
  subscribes to `ctx.data.listen`, and feeds the shared state machine.

The TUI's event feed is **not** limited to its own sessions, so `createSessionScope`
only accepts a root session while it is the routed session (`ui.router.current()`) or an
open session tab (`ui.tabs.list()`), checked on every event; children follow their root
via `session.created`'s `parentID`. Without that, two OpenCode tabs report each other. A
root the TUI stops showing is released on its next event: its state machine is disposed
and its part of the tab's status clears. The TUI API has no route or tab change event, so
that release is lazy.

One TUI feeds several session tabs, so each root session gets **its own** `hooks.ts` state
machine (`session-statuses.ts`), and the tab reports the combined state: attention (the
most recent prompt) > started > stopped > cleared. A shared machine would let one session's
completion report another's running turn as finished.

There is **one state machine** for both APIs. `src/v2/events.ts` translates v2 events
onto the v1 runtime-event shape `hooks.ts` consumes (`session.execution.*` → status/idle/
error, `session.created` → child classification via `parentID`, `form.created` →
`question.asked`, `session.text.*`/`session.reasoning.*` → part updates/deltas,
`permission.asked` `{ action, resources }` → the fields `commandFromPermission` probes).
A user `session.inbox.enqueued` item stands in for `chat.message`, and the cleanup
`setup` returns stands in for `dispose`. There is no `shell.env` equivalent on v2: agent
shells are spawned by the service, so they do not get the tab's `PRAGMA_*` env. Change
status behavior in `hooks.ts`, never in the v2 adapter.

Verified live against OpenCode 2.1.1 with `opencode --standalone` in a pty and a fake
gateway: `cleared` on start, user message → `running` → assistant text → `done`, and
`cleared` on exit, all carrying the TUI's tab id. A TUI picks up a rebuilt `tui.mjs` on
its next launch; the server entry only reloads with `opencode service restart`.

v2 questions arrive as forms (`form.created` / `form.replied` / `form.cancelled`); there
is no `question.asked` event. The watcher still answers with TUI keystrokes, whose layout
on v2's TUI is unverified.

## Installation

**`scripts/install.mjs` selects the API.** It reads `opencode --version` (override with
`PRAGMA_OPENCODE_PLUGIN_API=v1|v2`) and, for v1, registers the pinned package in `plugin`;
for v2, registers this install's absolute `dist/v2` **directory** in `plugins`, because
the package root is the v1 entry. v2 rejects a path to a file (`configured plugin path
must be a directory` in `~/.local/share/opencode/log/opencode.log`) and loads the
directory's `.` export, so the build's `scripts/stage-v2-package.mjs` writes
`dist/v2/package.json`. A path plugin loads (`loading plugin … entrypoint=…` in that log)
but does **not** appear in `opencode plugin list`, which lists package plugins only; the
v2 background service (`opencode service restart`) loads plugins only when it starts. Each run removes every earlier entry of ours from both
keys (package specifiers and paths to our bundles), so switching OpenCode versions means
re-running the installer. A missing or unreadable `opencode` falls back to v1.

**Pragma no longer auto-installs the opencode plugin** — the old
`src-tauri/src/opencode_plugin.rs` installer was removed. Local development registers built
`packages/opencode-plugin/dist/index.mjs` absolute path in `plugin` array of
`~/.config/opencode/opencode.json`; official npm install registers the pinned
`@pragma-sh/opencode-plugin@<version>` (`scripts/install.mjs`).

**opencode does NOT auto-load plugins from any directory** (verified against opencode
1.17.8). Only a `plugin`-array entry loads a plugin. A **file path / `file://` URL**
entry loads fine and is **not** npm-resolved. A package entry is npm-resolved **once**: opencode
caches a bare name as `<name>@latest` under `~/.cache/opencode/packages/` and never re-resolves
it, so an unpinned entry stays on the first version it fetched forever. The installer therefore
pins its own version and replaces any earlier `@pragma-sh/opencode-plugin[@…]` entry.

## State machine (hooks.ts)

`hooks.ts` is a **two-flag state machine** (`busy`, `attention`) rather than a
per-event mapping. The reported status is _derived_ (`attention` > `busy` > idle) and
emitted only on change.

Status sends are serialized through one promise queue. OpenCode can invoke adjacent
event hooks concurrently; without serialization, a slow `started` HTTP request from an
earlier turn could arrive after its `stopped` request and leave the tab incorrectly busy.

Only root sessions feed normal status and transcript handling — **except prompts**.
A subagent's `permission.asked` / `question.asked` (and the `question` tool hook) raise
the same attention as the parent's, and their replies clear it: permission and question
handlers run before child-session filtering, which used to swallow them silently. `session.created` /
`session.updated` events identify subagent sessions by `info.parentID`; child lifecycle
is tracked separately so a parent idle cannot report finished while any of its children
remain active. Child classification survives partial `session.updated` payloads that omit
`parentID`, and only the parent's final idle after all children finish reports stopped.

**`busy` is set by:**

- `chat.message`, `command.execute.before`, non-question `tool.execute.before`,
  `session.status` busy/retry, and `session.next.shell.started` for a standalone
  OpenCode shell command (which may have no session busy/idle pair)

**`busy` is cleared by:**

- `session.idle`, `session.status` idle, a non-abort `session.error`, `session.deleted`
- `session.next.shell.ended` finishes its matching standalone shell call; overlapping
  shell calls and agent work keep the tab running until all have finished

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
Once a canonical question is active, later legacy part updates are ignored and only a
matching canonical reply/rejection clears it; stale events from an earlier question must
not replace or clear the current request id.

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
   its TUI prompt mounts, especially during parallel verification. Current OpenCode
   then shows a confirmation step, so the watcher sends a final Enter after the
   answer. Helper: `questionAnswerKeys`.

Each agent plugin declares its watcher in `src/pragma-plugin.ts`. The catalog sidecar
reports matching bundle metadata to server, which starts `pragma-watch` for a headless
launch. opencode approval/question answering additionally requires opencode status plugin
(installed in opencode); interjection works for any watcher-backed agent.

**`dispose` (agent process exiting) reports `cleared`**, not `stopped` — quitting
opencode removes the indicator; finishing a turn (`session.idle`) still reports `done`.

**On load (`PragmaOpencodePlugin` in `index.ts`) the plugin fires one `cleared` up
front** so opening opencode never inherits a stale indicator from a previous run in the
same tab that exited without cleanup (`dispose` only runs on a graceful quit; a crash
leaves the last status lingering in the long-lived daemon).

Reporting uses the fetch-based `@pragma-sh/sdk` gateway helpers. Plugin options no longer
accept `executable` or `cwd`; the SDK no-ops through `hasPragmaEnvironment()` unless
`PRAGMA_GATEWAY_URL`, `PRAGMA_GATEWAY_TOKEN`, `PRAGMA_TAB_ID`, and
`PRAGMA_WORKTREE_ID` are present.

## Conversation tracking + resume

The plugin reports the tab's current **top-level conversation id** as a status-less
`session-id` report (SDK `reportSessionId`), so Pragma can resume that exact OpenCode
session through the agent's `launch.resume` callback.

**Where the id comes from — and its limit (verified against opencode 1.18.35).**
opencode's server API has **no "currently selected session" event**: the TUI keeps its
route in its own process (`api.route.current`, exposed only to a `tui.json` TUI plugin)
and never publishes selection. `session.created` / `session.updated` are also not proof
of selection — a root session can be created, renamed, or kept busy in the background
while the user views another. The only authoritative selection signal a server plugin
can see is **user-initiated activity**: `chat.message` (a submitted prompt) and
`command.execute.before` (a slash command). The tracker latches that session's id and
reports each change (A→B→A included; keyed on ids only, so same-title and untitled
switches work). A switch that never prompts is not observable from here — a documented
limit, not a silent approximation. Background root activity (`session.status`,
`tool.execute.before`, `message.*`) never moves the latch, and child sessions
(`info.parentID`) are tracked separately and never reported.

`session.deleted` for the latched session reports `null` (the SDK's explicit
`clearHarnessSessionId`), so the durable record cannot keep offering a resume of a
deleted conversation; the next user activity latches and reports the new one. Deleting
a background root or a child never clears — a deletion is only authoritative when it
names the tracked session, and child deletions are consumed by the subagent tracker
before this path. Aborting a turn or quitting opencode deliberately does **not** clear:
the conversation still exists and stays resumable. Nothing reports a session-ended
state — the host's supervised invocation tracks the real TUI exit separately.

**A brand-new conversation's id is unknown until it is first prompted (verified against
opencode 1.18.35).** `session.new` (or `/new`) only navigates the TUI back to its home
route; the session itself is created server-side when the first prompt is submitted,
which is also the `chat.message` that reports its id. `session.created` cannot stand in
for selection: background roots (another client, `opencode run`, a plugin) emit it too,
so treating it as a selection would hand the tab — and a later resume — to a
conversation the user never opened. After a deletion clear, the stored id stays cleared
until the next user activity (a prompt or slash command) reports the conversation it
lands in. The TUI-level `api.route.current` signal would close this gap, but it is
available only to a `tui.json` TUI plugin, and a module cannot be both the server and
TUI plugin target.

**Resume.** `launch.resume` returns the full literal argv
`["opencode", "--session", <id>, ...selection args]`. `--session`, `--model`, and
`--agent` are all top-level options (verified with `opencode --help`), so an explicit
launch selection is replayed and no default mode is forced — the stored session keeps
its own agent/model. The original slash command and prompt are never replayed.

## Plugin launcher

The launchable OpenCode entry is defined **here** in `src/pragma-plugin.ts` — this is now
the single source of truth. The `pragma-plugins` catalog sidecar imports its built bundle
to assemble agent catalog and watcher metadata. Its icon asset stays in this package
under `assets/`, not in Pragma core.

Modes (Shift+Tab in the launcher) come from `opencode agent list`: every `primary`/`all`
agent except the internal `compaction`, `summary`, and `title`, with `build` and `plan`
first (and the fallback when the command fails); `--agent <name>` starts one. Slash commands
come from `opencode acp` (the ACP `available_commands_update`, which includes skills and
custom commands), with `/init`, `/review`, and `.opencode` / `~/.config/opencode` command and
skill folders as the fallback.
OpenCode has no permission-mode flag, so `permissionModes` stays empty.

`prefillDelayMs` is set higher than the core default because opencode's TUI can take
longer to mount its input in a background PTY before prompt paste/submit is reliable.

Plugin model provider owns all opencode-specific parsing. It tries supported
opencode model-list surfaces (`opencode models --json`, then `--verbose`, then plain
`opencode models`) and returns Pragma's generic model entries. Each model's display name
gets its provider appended in parentheses (e.g. `Claude Sonnet 4 (anthropic)`), derived
from the `provider` field or the `provider/model` id prefix. Fast variants stay separate
model entries when opencode exposes separate IDs. Reasoning is omitted unless opencode
exposes reliable per-model reasoning levels.

OpenCode Go usage on **v1** comes from the supported `opencode db <query> --format json`
command. **v2 dropped `opencode db`**: `loadOpenCodeGoUsageLimitsV2` instead asks the
server's session statistics (`opencode api GET /api/experimental/session/stats?from=&to=`,
one call per window, run concurrently) and sums the `opencode-go` models' `cost`. That
endpoint is **experimental** — expect it to move. It returns aggregates only, so on v2 the
5-hour window has no reset time; and v2 keeps one database for every account, so v2 usage is
the device's OpenCode Go usage whichever key paid for it. The provider sums assistant-message costs whose provider is `opencode-go` against Go's
documented $12/5-hour, $30/week, and $60/month limits. The 5-hour reset follows the first
local message in the active rolling window; weekly reset is Monday UTC; monthly reset is
the next UTC calendar month because OpenCode's local database does not expose the account's
subscription anchor.

This source is device-local. Requests from other devices or agents do not appear, so the
provider can undercount account-wide usage. Do not read browser cookies or OpenCode's raw
credential file to improve it; switch to an OpenCode-owned authenticated usage endpoint if
one becomes available. A machine with no local `opencode-go` messages reports `unsupported`,
and transport or parser failures throw so `agent verify` detects regressions.

## Account provider

All providers are `agent: "opencode"`:

Every provider is built with `openCodeStoreAccount` (`src/accounts.ts`), which wraps
`credentialStoreAccount({ switchable: true })` and asks `isOpenCodeV2` (a cached
`opencode --version`) in every callback:

- **v1** — swap: the server calls `swap.activate` before every launch and the provider's
  entries are swapped in and out of the one shared `auth.json`. OpenCode reads `auth.json`
  per request, so running sessions follow a switch.
- **v2** — OpenCode keeps accounts in its own database (`opencode auth list` / `switch`), and
  `auth.json` is only imported once. A Pragma login is bound to **one v2 credential labelled
  `pragma:<loginId>`**; `activate` calls `POST /api/credential/<id>/activate` through
  `opencode api`, and OpenCode refreshes the credential itself, so Pragma never mirrors a
  rotating token. The harness's own sign-in is the integration's unlabelled credential. A new
  login signs in in place: `activate` finds no bound credential, records the existing ids in
  `<home>/opencode/pragma-v2-pending.json`, `opencode auth login` adds and activates a new one,
  and the next `identify` claims (relabels) the credential that is not in that snapshot.
  A login saved before OpenCode 2 (its key still in `<home>/opencode/auth.json`) binds to the
  v2 credential holding the same secret when OpenCode imported it; with no match, `activate`
  refuses and asks for a sign-in again, because OpenCode would otherwise activate its default
  account and the login would silently use another one.
  Credential values are mapped to the `auth.json` entry shape (`credentialEntry`) so the
  shared identity and token helpers stay the single derivation.
- **v2 cannot borrow a sign-in** (`sharedToken.write` throws; `read` still lends). Creating a
  credential would put its secret in the `opencode api -d` argument — `opencode api` reads a
  body from neither stdin nor a file (`-d @file` and `-d -` are taken literally) — where
  other local users can read it. Only label-only bodies go on that command line.

**OpenCode Go no longer has an `XDG_DATA_HOME` per account.** v2 serves every OpenCode
process from one background service, and `XDG_DATA_HOME` only moves the CLI's own paths
(`opencode debug paths`) while `opencode api` still reaches the shared service and its
credentials — verified. It therefore switches like the others; a server ignores `swap`
whenever `env` is set, so it could not keep both. Existing logins carry over, because the swap
reads a login's saved entries from `<home>/opencode/auth.json`, exactly where `env` stored
them. On v1 the trade-off is that its accounts now share one session history.

**Login is bare `opencode auth login`** (the provider picker), with instructions naming what
to pick: v1 preselects with `--provider`, v2 with a positional target, each rejects the
other's form, and Pragma types the command into the user's shell (POSIX or PowerShell), so a
version check there is not portable. OpenAI and Copilot declare no usage and no `iconPath`, so
the merged row takes both from Codex / Copilot CLI. ChatGPT is shared with Codex, Pi and
Prime Agent (kind `chatgpt`); Copilot only as `github-copilot:Ov23li8tweQw6odWQebz`, because
OpenCode signs in to GitHub through its own OAuth app and no other harness uses it. Every
API-key provider lends and takes its key on v1. `OPENCODE_AUTH_CONTENT` was rejected: it
replaces every credential, puts tokens in the environment, and a refresh writes the merged
set back into the real `auth.json`.

`identify` reads the provider's entry in `auth.json` (v1) or its bound credential from `GET /api/credential` (v2), because OpenCode exposes no command that reports the signed-in account. That is the one sanctioned read of the credential store: in the sidecar, identity only, never refreshed or rewritten. The usage rule above still stands — do not use the raw credentials to fetch usage. OpenAI is decoded offline from the ChatGPT JWT (id = email, matching Codex); Copilot calls `GET api.github.com/user` with the GitHub token (id = lowercased login); OpenCode Go is a SHA-256 digest of the key (`key:<16 hex>`), which merges with Pi and Prime Agent holding the same key.

- `OPENCODE_API_KEY_PROVIDERS` — `modelsDevAccountProviders(["openai", "opencode-go"])` from `@pragma-sh/plugin`: every other provider OpenCode holds a key for (Anthropic, Google Gemini API, xAI, OpenCode Zen, OpenRouter, DeepSeek, Groq, Mistral, Cerebras, Fireworks, Together, Hugging Face, NVIDIA, Vercel AI Gateway, Z.ai, MiniMax, Kimi Code, Moonshot AI Platform, Xiaomi MiMo), each mapped to its `auth.json` entry ids (models.dev ids, most specific first). Built with `openCodeStoreAccount`, switchable like `openai`, `apiKeyOnly: true`; login is the bare picker, then a key prompt. Providers without a plain key in `auth.json` (Bedrock, Azure, Vertex, Cloudflare) are left out. The toolbar menu hides one until OpenCode is signed in to it; Add account still lists it.

**Only add a provider whose credential may be used outside its own first-party harness.** Claude Free/Pro/Max OAuth is restricted by Anthropic's terms to Claude Code and claude.ai, and Google suspends accounts that use Gemini CLI or Antigravity OAuth in other tools — so in any other harness, Anthropic and Google are API-key only (`apiKeyOnly: true`), and their OAuth sign-ins are never identified or presented as accounts. ChatGPT (Codex OAuth) and GitHub Copilot sign-ins are sanctioned in OpenCode and Pi. That is why Anthropic is key-only here even though OpenCode 1.18 no longer ships Claude OAuth: a stale or plugin-written OAuth entry must still not be shown.
