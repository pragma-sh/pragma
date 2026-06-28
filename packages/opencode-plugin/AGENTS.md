# packages/opencode-plugin — @pragma/opencode-plugin

ESM opencode plugin that reports agent status into Pragma. Built with Bunup
(ESM-only). Imports opencode plugin types from `@opencode-ai/plugin`, reacts to
opencode hooks/events, and reports `started` / `stopped` / `attention` / `cleared`
through `@pragma/sdk`.

## File map

```
packages/opencode-plugin/
├── src/
│   ├── index.ts         # PragmaOpencodePlugin entry point
│   └── hooks.ts         # Two-flag state machine (busy + attention)
├── pragma/agents/opencode/
│   ├── config.json      # Bundled launcher config + model metadata
│   └── scripts/list-models.sh  # opencode model listing → generic Pragma JSON
└── dist/index.mjs       # Built output (Bunup; git-ignored)
```

The built `dist/index.mjs` is **not** bundled by Pragma — `stage-daemon-sidecar.sh`
stages only the server/`pragma-cli` sidecars and the bundled agent launcher configs
(`pragma/agents/`). To use the plugin, register its absolute path in opencode's own
`plugin` config (see _Installation_ below).

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

**`busy` is set by:**

- `chat.message`, `command.execute.before`, non-question `tool.execute.before`,
  `session.status` busy/retry

**`busy` is cleared by:**

- `session.idle`, `session.status` idle, a non-abort `session.error`, `session.deleted`

**`stopped` (green "done") is only emitted after a `started`** — a bare `session.idle`
or an idle trailing an aborted/cleared turn must not resurrect a phantom "done" dot.

**An aborted turn** (esc-esc / `session.abort`) surfaces as `session.error` carrying
`MessageAbortedError` and reports `cleared`, not `stopped`.

**`server.instance.disposed` reports `cleared`** — opencode quitting clears the dot
even when the `dispose` plugin hook doesn't run (abrupt shutdown).

**`attention` is raised by:**

- The `permission.asked` event (command) and the `question` tool (via
  `tool.execute.before` or a pending `message.part.updated` part)

**`attention` is cleared by:**

- `permission.replied` or the question part completing/erroring

**Permission events — verified empirically:** the runtime emits `permission.asked` /
`permission.replied` (NOT the `permission.updated` the TS `Event` union declares), and
it **never calls the `permission.ask` plugin hook** (absent from the binary). The plugin
`event` hook does receive `permission.asked`, which is why event-based detection works.
The legacy `permission.ask` hook + `permission.updated` event are kept only as harmless
cross-version fallbacks. Only real opencode events are handled — **do not re-add the
speculative `session.next.*` events** (opencode does emit
`session.next.agent.switched` / `session.next.model.switched`, but they carry no status
meaning; mapping them was the source of the stuck-yellow bug).

**`dispose` (agent process exiting) reports `cleared`**, not `stopped` — quitting
opencode removes the indicator; finishing a turn (`session.idle`) still reports `done`.

**On load (`PragmaOpencodePlugin` in `index.ts`) the plugin fires one `cleared` up
front** so opening opencode never inherits a stale indicator from a previous run in the
same tab that exited without cleanup (`dispose` only runs on a graceful quit; a crash
leaves the last status lingering in the long-lived daemon).

## Agent launcher config

`pragma/agents/opencode/config.json` — fields: `id`, `name`, `icon`, `start`, and
optional `models` / launch timing. Icons must resolve inside that agent directory. Staged to
`apps/pragma/src-tauri/resources/pragma/agents/` by `stage-daemon-sidecar.sh`.

The `models` block is command-backed and runs with cwd set to the installed agent
directory (`~/.pragma/agents/opencode`):

```json
"models": {
  "source": "command",
  "command": ["sh", "scripts/list-models.sh"],
  "modelArg": ["--model", "{model}"]
}
```

`prefillDelayMs` is set higher than the core default because opencode's TUI can take
longer to mount its input in a background PTY before prompt paste/submit is reliable.

`scripts/list-models.sh` owns all opencode-specific parsing. It tries supported opencode
model-list surfaces (`opencode models --json`, then `--verbose`, then plain
`opencode models`) and emits Pragma's generic JSON array. Each model's display name
gets its provider appended in parentheses (e.g. `Claude Sonnet 4 (anthropic)`), derived
from the `provider` field or the `provider/model` id prefix. Fast variants stay separate
model entries when opencode exposes separate IDs. Reasoning is omitted unless opencode
exposes reliable per-model reasoning levels.
