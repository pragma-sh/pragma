# packages/grok-plugin - @pragma/grok-plugin

Self-contained xAI **Grok Build** CLI integration. Grok loads no in-process JavaScript
plugin, so lifecycle reporting uses grok's native hooks plus `pragma-cli`. TypeScript
defines the Pragma launcher, watcher, model discovery, and usage limits.

## File map

```
packages/grok-plugin/
├── .grok-plugin/plugin.json  # Grok plugin manifest (packaging only; see "Why global hooks")
├── assets/grok.svg           # Official Grok mark, launcher + usage icon
├── hooks/
│   ├── hooks.json            # Grok lifecycle hook declarations (source of truth)
│   └── report.sh             # Event -> pragma-cli state machine
├── scripts/install-local.ts  # Writes ~/.grok/hooks/pragma-grok.json from hooks.json
├── src/acp.ts                # `grok agent stdio` ACP client (models + billing)
├── src/pragma-plugin.ts      # Pragma agent, watcher, model provider
├── src/usage-limits.ts       # `_x.ai/billing` normalization
└── test/report.test.ts       # Fake-pragma-cli shell-hook tests
```

## Host route and tested surface

Tested against `grok 0.2.114 (0c785038798) [stable]` on 2026-07-29. Grok has no
in-process JS/TS plugin runtime, but it does ship a Claude-Code-compatible hook system
that reads `hooks.json` files, and an ACP (`grok agent stdio`) entry point for structured
queries. Official references:

- Hooks: `~/.grok/docs/user-guide/10-hooks.md` (ships with the CLI; also in `~/.grok/README.md`)
- Plugins: `~/.grok/docs/user-guide/09-plugins.md`
- Agent/ACP mode: `~/.grok/docs/user-guide/15-agent-mode.md`

### Why global hooks, not a grok plugin

**Grok 0.2.114 discovers a plugin's `hooks/hooks.json` but never dispatches it.** After
`grok plugin install <path> --trust` the file shows up in `grok inspect`
(`└ file  plugin: pragma-grok`) and in `/hooks`, yet the dispatcher logs
`hooks: starting discovery global_sources=4 project_sources=0` — counting only
`~/.grok/hooks/`, `~/.claude/settings.json`, `settings.local.json` and
`~/.cursor/hooks.json`. No plugin source is ever added, so not one plugin hook fires.
(`pragma-claude-code`, installed through the Claude-compat path, is silently dead in grok
for the same reason.) Reproduce with
`RUST_LOG=xai_grok_hooks=debug GROK_LOG_FILE=/tmp/grok.log grok -p hi`.

`scripts/install-local.ts` therefore installs into `~/.grok/hooks/pragma-grok.json`, which
is always discovered and **always trusted** — no `/hooks-trust`, no project-trust prompt.
`hooks/hooks.json` stays the single source of the event map; the installer only rewrites
`${GROK_PLUGIN_ROOT}` to this package's absolute path, because a global hook file gets no
plugin-root injection. The installed file points back at this checkout, so **edits to
`hooks/report.sh` take effect on grok's next session with no reinstall** — unlike the
Codex and Claude plugins, whose installs are snapshots. Re-run `install:local` only after
changing `hooks/hooks.json` itself, or after moving the checkout.

`.grok-plugin/plugin.json` is kept so `grok plugin validate` passes and the directory is
installable as a plugin the day grok wires plugin hooks into the dispatcher. If that
happens, drop the global-hook installer rather than running both — they would double every
report.

## Hook to status mapping

| Grok hook              | Script event     | Pragma behavior                                                    |
| ---------------------- | ---------------- | ------------------------------------------------------------------ |
| `SessionStart`         | `cleared`        | Clears stale status, watcher, and child markers                    |
| `UserPromptSubmit`     | `started`        | Reports running, names the session, starts the abort watcher       |
| `Stop`                 | `stopped`        | Done only for `reason == "end_turn"` with a marker and no children |
| `StopFailure`          | `failed`         | Clears (an API-error turn never completed) and names the error     |
| `SubagentStart`        | `subagent-start` | Tracks the child, reasserts running                                |
| `SubagentStop`         | `subagent-stop`  | Removes only the matching child; the parent `Stop` owns done       |
| `PreToolUse`           | `question`       | `ask_user_question` only: raises structured question attention     |
| `PostToolUse(Failure)` | `running`        | Reasserts running once a tool finishes mid-turn                    |
| `SessionEnd`           | `cleared`        | Clears status and forgets the session/name state                   |
| Transcript watcher     | -                | Streams assistant output; clears on a cancel no hook reports       |

`report.sh` uses agent id `grok` — the FINAL segment of the resolved catalog id
(`pragma.grok`), never the qualified id. Chat consumers filter the event stream by that
runtime id (mobile `runtimeAgentId`, watcher `agentId`), so reports under `pragma.grok`
would be invisible to them. The script exits immediately outside Pragma and swallows every
reporting failure. `stopped` is impossible without an active marker, so a bare `Stop`
cannot create a phantom done dot.

### Grok payload differences from Claude Code

Verified by capturing every event with a temporary `~/.grok/hooks` probe:

- **camelCase everywhere.** `sessionId`, `hookEventName`, `toolName`, `toolInput`,
  `toolResult`, `lastAssistantMessage`, `stopHookActive`, `backgroundTasks`,
  `transcriptPath`. A script ported from Claude that reads `hook_event_name` sees nothing.
- **`hookEventName` values are snake_case** (`user_prompt_submit`, `pre_tool_use`,
  `stop`), not the PascalCase names used as hook-file keys.
- **`transcriptPath` is handed to every event** and points straight at the session's
  `updates.jsonl`, so nothing has to reconstruct grok's URL-encoded session directory.
- **A second, observe-only `Stop` fires at session end** with `reason` `shutdown` /
  `channel_closed`, after `SessionEnd`. Only `end_turn` may report done.
- **The prompt arrives wrapped** in `<user_query>…</user_query>`; it is unwrapped before
  becoming a chat bubble or a session name.
- **There is no permission-request hook.** `PreToolUse` fires for _every_ tool before the
  permission system runs and can only allow or deny, so command approvals cannot be
  brokered through Pragma (`excludeFeatures: ["commandApproval"]`).

## Session names

Grok generates its own conversation title into `summary.json`, a sibling of the
transcript (`generated_title`, falling back to `session_summary`). `report.sh` prefers it
and falls back to the first prompt's first nonblank line (47 characters plus `…`) for the
opening turn, before grok has summarized anything. The name is reported only when it
changes, so the tab is renamed once per title — typically once from the prompt, then once
to grok's title when the first turn ends. Pragma preserves a manual tab rename regardless.

## Assistant message streaming

Grok records one `agent_message_chunk` per streamed delta in `updates.jsonl`. The
turn-scoped watcher concatenates every chunk past the turn's starting byte offset and
reports the growing text under one stable id (`grok-<turn-token>-assistant`), so chat
consumers (mobile) update a single bubble live instead of receiving a wall of fragments or
one message after `Stop`.

`stopped` emits the final reply **before** reporting done, so the reply event always
precedes it. **It has to combine both sources — neither is complete on its own**, which
only showed up in a live run:

- The transcript holds every chunk of the turn, but grok fires `Stop` _before_ flushing the
  last one. Reading it alone silently drops the closing text (observed: a turn that ended
  "…DONE" reported only "Running the command now.").
- `lastAssistantMessage` holds exactly that closing text and nothing else — grok emits one
  assistant message per tool round — so using it alone would replace a whole turn's reply
  with its final sentence.

So `stopped` concatenates the synced transcript text with `lastAssistantMessage` unless the
transcript already ends with it, and reports the result under the same stable id the
watcher streamed to. A turn with no transcript path (or a host without python3) falls back
to `lastAssistantMessage` alone.

## Abort and exit handling

An interrupted turn (Esc / Ctrl+C) **skips `Stop` hooks entirely** — grok runs the gate
only for genuine completions, and fires `StopFailure` instead for API errors. So a
hook-only bridge can never see a cancel. Both durable signals sit next to the transcript,
and the per-turn watcher polls both:

- `signals.json`.`cancellationCount`, a monotonic counter; the watcher captures its value
  at turn start and clears the moment it grows.
- a `turn_completed` record in `updates.jsonl` whose `stop_reason` is not `end_turn`:

  ```json
  { "sessionUpdate": "turn_completed", "prompt_id": "…", "stop_reason": "cancelled" }
  ```

  scanned only past this turn's starting byte offset, so a previous turn's cancel record —
  which is the file's last line the instant a new turn starts — cannot clear a turn that
  is merely thinking.

Turn-token ownership, watcher replacement, and a 24-hour backstop keep stale watchers from
clearing later work. `SessionEnd` covers a graceful exit; the Pragma watcher's `finally`
reports `cleared` for a session killed hard enough that no hook runs.

## Models and usage limits

Both come from one short-lived `grok agent stdio` process (`src/acp.ts`), so Pragma never
reads `~/.grok/auth.json` — grok owns its credentials and refresh.

- **Models**: `grok models` prints a human list with no machine-readable flag, but the ACP
  `initialize` result carries the same catalog structured under
  `_meta.modelState.availableModels`, including per-model `reasoningEfforts`. Launch uses
  `--model`; reasoning uses `--reasoning-effort`. A failed query returns `[]` so the
  launcher still opens and grok starts on its configured default.
- **Usage**: the `_x.ai/billing` extension method. **It must be called as `_x.ai/billing`** —
  the `_`-prefixed ACP-unstable form. The unprefixed `x.ai/billing` seen in the binary's
  strings answers `Method not found`. The payload varies by plan: `creditUsagePercent`
  against `currentPeriod` for a metered account, `includedUsed`/`monthlyLimit` for a
  seat-based one, plus an `onDemandUsed`/`onDemandCap` pair for pay-as-you-go. Money values
  are wrapped as `{ val }`.

A **free** account returns a period and three zeroed money fields with no percentage and
no limit — grok enforces a free ceiling ("You've reached your free Grok Build usage limit
for now") that this API does not expose. That is reported as `unsupported` with the tier
name rather than a row of zeros.

Grok has **no permission-mode flag**; the launcher's three modes map to real launch flags:
`default` -> none, `no-plan` -> `--no-plan`, `always-approve` -> `--always-approve`.

## Branding provenance

`assets/grok.svg` is the official Grok product mark, downloaded from
`https://grok.com/images/favicon.svg` (linked from grok.com's own `<link rel="icon">`) on
2026-07-29. It is the Grok product icon, not the xAI corporate mark. Sanitized before
committing: the `<foreignObject>` XHTML `backdrop-filter` div, its `bgblur` clip path, and
the drop-shadow filter were removed; `viewBox`, geometry, the glyph mask, and vendor colors
are unchanged. It carries its own near-black tile, so it reads on both light and dark
backgrounds. Refresh only from a first-party xAI/Grok source; do not trace, screenshot, or
substitute a third-party aggregator's copy.

## Installation

```bash
bun run --filter @pragma/grok-plugin build
bun run --filter @pragma/grok-plugin install:local
```

For the Pragma side, register this package's absolute path in global
`~/.pragma/config.json` under `plugins[]`. An absolute path ensures desktop plugin
discovery and the host catalog resolve the same directory; package metadata points Pragma
at `dist/pragma-plugin.mjs`.

The Pragma side is a cache: `pragma-server`'s long-lived `pragma-plugins` sidecar imports
`dist/pragma-plugin.mjs` once, and the `plugins reload` RPC re-runs the import with a
bundle-mtime cache bust. If a stale catalog persists, kill `pragma-plugins` (its supervisor
respawns it lazily) or restart the detached `pragma-server`. While the desktop app is
running it brokers headed launches from its _own_ plugin copy, so quit it before
`agent verify` if a launch flag looks stale.

## Verification

```bash
bun run --filter @pragma/grok-plugin test
bun run --filter @pragma/grok-plugin typecheck
bun run --filter @pragma/grok-plugin build
pragma-cli agent verify --agent pragma.grok --abort-input '\x1b'
```

Only `commandApproval` is skipped by `excludeFeatures` — grok owns that prompt in its own
TUI and exposes no hook that can answer it. `ask_user_question` reports question text,
options, and request id; the Pragma watcher answers Grok's native card with digit shortcuts
plus Enter confirmation, `z` for free text, or `Shift+X` for dismissal. Everything else (started/stopped/cleared,
session name, subagents, abort, interrupt, usage limits, stream integrity) is in scope.

Verification burns real tokens against the signed-in account. A free-tier account hits
grok's usage ceiling quickly, and a rate-limited turn is recorded as
`"stop_reason":"cancelled"` with empty output — which the bridge (correctly) reports as
`cleared`, so scenarios fail for reasons that have nothing to do with the plugin. Check
`~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl` for that record before debugging a
failure.
