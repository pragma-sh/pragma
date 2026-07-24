# packages/codex-plugin - @pragma/codex-plugin

Self-contained OpenAI Codex CLI integration. Codex plugins are declarative bundles, not
in-process JavaScript plugins, so lifecycle reporting uses Codex's native command hooks and
`pragma-cli`. TypeScript defines Pragma launcher, watcher, model discovery, and usage limits.

## File map

```
packages/codex-plugin/
├── .agents/plugins/marketplace.json # Local Codex marketplace
├── .codex-plugin/plugin.json        # Codex plugin manifest
├── assets/
│   └── codex.png                    # Official Codex artwork, launcher + usage icon
├── hooks/
│   ├── hooks.json                   # Codex lifecycle hook declarations
│   └── report.sh                    # Event -> pragma-cli state machine
├── scripts/install-local.sh         # Codex marketplace add + plugin install
├── src/pragma-plugin.ts             # Pragma agent, watcher, models, usage limits
├── src/usage-limits.ts              # app-server account/rateLimits/read client
└── test/report.test.ts              # Fake-pragma-cli shell-hook tests
```

## Host route and tested surface

Tested against `codex-cli 0.144.4` on 2026-07-15; question flow (including the free-text
interject fallback) re-verified against `codex-cli 0.144.5` on 2026-07-16. On 0.144.5 a
session launched with the feature flag can still occasionally reject the tool call with
`request_user_input is unavailable in Default mode`; a fresh session succeeds, and
`agent verify`'s per-scenario retry absorbs it. Codex has no in-process JS/TS plugin
runtime. Stable `hooks` and `plugins` features load `hooks/hooks.json` from an installed
plugin. Hook commands receive JSON on stdin and `PLUGIN_ROOT` / `PLUGIN_DATA`.

Codex requires hash-based trust for non-managed plugin hook definitions. Installing or changing
`hooks/hooks.json` does not trust the new definition automatically; restart Codex and use
`/hooks` to review it. Editing only the invoked `hooks/report.sh` does not change the definition
hash and does not trigger another trust prompt.

Official references:

- Hooks: https://developers.openai.com/codex/hooks/
- Plugin packaging: https://developers.openai.com/codex/build-plugins/
- App server: https://developers.openai.com/codex/app-server/
- Tagged source: https://github.com/openai/codex/tree/rust-v0.144.4

## Hook to status mapping

| Codex hook                      | Script event     | Pragma behavior                                                               |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `SessionStart`                  | `cleared`        | Clears stale status, watcher, and child markers                               |
| `UserPromptSubmit`              | `started`        | Reports running; first prompt derives `session-name`; starts abort watcher    |
| `Stop`                          | `stopped`        | Reports done only with an active turn marker and no active children           |
| `SubagentStart`                 | `subagent-start` | Tracks child by `agent_id`, reasserts running                                 |
| `SubagentStop`                  | `subagent-stop`  | Removes only matching child; parent `Stop` owns done                          |
| `PermissionRequest`             | `permission`     | Reports command attention and blocks for finite remote decision               |
| `PostToolUse`                   | `running`        | Reasserts running after approved tool completes                               |
| Transcript `request_user_input` | abort watcher    | Reports single-question attention; watcher returns remote answers as TUI keys |
| Transcript `agent_message`      | abort watcher    | Streams each completed assistant message (raw Markdown) mid-turn              |

`SubagentStart` also emits a system message with marker-derived
`subAgentsActive`. Status reports do not carry that count; without this message,
chat consumers and `agent verify` cannot observe real parallel activity.

## Assistant message streaming

Codex records one unescaped `event_msg`/`agent_message` rollout line per completed
assistant message, containing the raw Markdown source. The same turn-scoped watcher that
detects aborts syncs those lines every poll (`sync_messages`), so interim replies reach
Pragma chat consumers (mobile) while the turn is still running instead of one bubble after
`Stop`. Message ids are `codex-<turn>-assistant-<index>` with a zero-padded index (same-poll
batches share a timestamp; consumers tiebreak by id). A sent-count state file dedupes
across polls and across the final sync that `stopped` performs before reporting done —
so the reply event always precedes the `stopped` report. `Stop`'s `last_assistant_message`
remains only as a fallback when no transcript (or no python3) is available; it reuses the
unindexed `codex-<turn>-assistant` id. Rollout granularity is per completed message —
Codex does not persist token deltas to the rollout, so this is the finest streaming the
hook surface offers.

`report.sh` uses agent id `codex` — the FINAL segment of the resolved catalog id
(`pragma.codex`), never the qualified id. Chat consumers filter the event stream by that
runtime id (mobile `runtimeAgentId`, watcher `agentId`, the other first-party hook
plugins), so reports under `pragma.codex` are silently invisible to them; `agent verify`
scopes events by the runtime id only to catch exactly that. The script exits immediately
outside Pragma and swallows every reporting failure. `stopped` is impossible without an
active marker, preventing bare `Stop` from creating a phantom done dot.

Codex exposes no reliable native session title through its hook payloads. `report.sh`
derives one from the first prompt's first nonblank line (47 characters plus `…` when truncated), reports it
once per session, and resets that state on `SessionStart`.

## Permission decisions

`PermissionRequest` is a blocking Codex hook. Script reports command text plus request id,
waits up to `PRAGMA_APPROVAL_TIMEOUT` (default 300 seconds), then returns Codex's documented
`allow` or `deny` decision JSON. Timeout emits no hook output, so Codex uses native prompt.
After a remote verdict, script reasserts running before returning; denial is model-visible
feedback and does not necessarily end turn.

Codex 0.144.4 has no `request_user_input` hook. The turn-scoped transcript does record a
`response_item` function call before Codex shows its question UI, followed by a matching
`function_call_output` after resolution. The same offset-scoped watcher used for aborts parses
those records, reports one-question requests with the function `call_id` as `requestId`, and
reasserts running after output appears. It deliberately ignores multi-question requests rather
than flattening a payload that Pragma cannot answer faithfully. This transcript shape is not a
stable Codex API and must be reverified on every tested-version bump.

Launcher passes `--enable default_mode_request_user_input`; without it, Codex 0.144.4 only
offers the tool in Plan mode and verification prompts cannot create question reports. Watcher
keeps `handleDecisions: false` for command decisions but enables question answers. Listed
answers use Codex's digit shortcuts and dismissal sends Escape. Custom free-text answers
have no editor in Codex's question UI: its generated last row is "None of the above", not a
"type your own" option. The watcher runs `questionFreeTextMode: "interject"` — it selects
"None of the above" to resolve the prompt, sends Escape to abort the response Codex starts
from that non-answer, then submits the real answer as a follow-up prompt of the form
`Answer to question "<question>": <answer>` (single line; Codex submits on Enter). Unmatched request ids are ignored.

## Abort and exit handling

ESC interruption does not emit `Stop`, `SubagentStop`, or another configurable hook. Codex
writes an unescaped rollout event immediately:

```json
{ "type": "event_msg", "payload": { "type": "turn_aborted" } }
```

On `UserPromptSubmit`, script records current transcript byte count and starts one detached,
per-tab watcher. It scans only bytes after that offset for the unescaped
`"type":"turn_aborted"` marker. Old aborts and escaped copies inside tool output cannot clear
new turns. Turn token ownership, watcher replacement, and a 24-hour backstop prevent stale
processes from clearing later work.

Codex exposes no `SessionEnd` hook. Pragma watcher runs for exact launched session and reports
`cleared` in `finally` when session exits. Direct Codex processes launched outside Pragma are
no-ops; direct commands inside a Pragma terminal but outside launcher do not have watcher-owned
exit cleanup and rely on next `SessionStart` stale clear.

## Models and usage limits

Model provider runs supported `codex debug models` command, keeps `visibility: "list"`, and
maps `supported_reasoning_levels[].effort`. Launch uses `--model`; reasoning uses
`--config model_reasoning_effort="..."`; permission modes use `--ask-for-approval`.

Usage provider launches short-lived `codex app-server --stdio`, performs required
`initialize` / `initialized` handshake, then calls stable `account/rateLimits/read`. Transport
and normalization live in bundled `src/usage-limits.ts`; `assets/` contains only static brand
artwork. Codex owns credentials and refresh, so Pragma never reads or prints tokens. Provider
normalizes primary and secondary windows to percentage limits and treats API-key-only /
signed-out accounts as `authentication-required`.

## Branding provenance

User selected official Codex artwork after review of redistribution uncertainty. Source is
OpenAI's signed ChatGPT macOS distribution from https://openai.com/chatgpt/desktop/, resource
`ChatGPT.app/Contents/Resources/icon-codex-light.png`, retrieved 2026-07-15. It is a
Codex-specific product icon, not OpenAI Blossom or a third-party aggregate. Original 1024 px
PNG was downsampled without cropping or color changes to fit Pragma's 256 KB catalog asset cap.

OpenAI's brand terms (https://openai.com/brand/) do not provide a broad trademark license;
the package must not imply OpenAI endorsement. Refresh only from a first-party OpenAI app or
published brand kit. Do not substitute Cursor's bundled Codex SVGs, favicons, traced artwork,
or generic terminal icons.

## Installation

```bash
bun run --filter @pragma/codex-plugin build
bun run --filter @pragma/codex-plugin install:local
```

Installer registers this package as local Codex marketplace and installs
`pragma-codex@pragma`. Restart Codex, run `/hooks`, and trust Pragma hook definitions. Re-run
install and trust again after `hooks/hooks.json` changes.

For local verification, register this package's absolute path in global
`~/.pragma/config.json`. An absolute path ensures desktop plugin discovery and the host
catalog resolve the same directory. Package metadata points Pragma to
`dist/pragma-plugin.mjs`.

**Both installs go stale independently after an edit.** The Codex side is a copy:
`codex plugin add` snapshots this package into `~/.codex/plugins/cache/pragma/...`, so
`hooks/report.sh` changes do nothing until `install:local` runs again. The Pragma side is
a cache: `pragma-server`'s long-lived `pragma-plugins` sidecar imports
`dist/pragma-plugin.mjs` once; the `plugins reload` RPC re-runs the import, and the
sidecar cache-busts the URL by bundle mtime, so a rebuilt bundle is picked up on reload.
A sidecar binary older than that fix keeps serving the first import (ESM module cache)
until the sidecar process itself restarts — kill `pragma-plugins` (its supervisor
respawns it lazily and the cached catalog holds in the meantime) or restart the detached
`pragma-server`. Confirm with `GET /v1/agents/catalog` that the `pragma.codex` launch
commands include `--enable default_mode_request_user_input` before running headless
`agent verify` — without the flag Codex never exposes the question tool and every
question scenario times out with the agent answering in plain text.

A correct catalog is still not sufficient while the desktop app is running: the server
forwards `agentSessionLaunch` to the app controller, and the app builds the spawn
command from its own plugin copy — a stale app silently drops the `--enable` flag even
though the gateway catalog shows it. Quit the desktop app before `agent verify` so
launches take the server's headless path (fresh sidecar catalog); persistent terminal
sessions survive because PTYs live in `pragma-server`. Confirm by inspecting the spawned
process: `ps -o command= -p $(pgrep -x codex)` must show the `--enable` flag.

## Verification

```bash
bun run --filter @pragma/codex-plugin test
bun run --filter @pragma/codex-plugin typecheck
bun run --filter @pragma/codex-plugin build
pragma-cli agent verify --agent pragma.codex --abort-input '\x1b' --include-slow
```

All question scenarios are required. They verify exact question text/options, request-id
correlation, listed/custom answers, and dismissal. `question-free-text` requires the agent
to echo the exact marker back and accepts the interject fallback as a secondary path:
"None of the above" selected, response aborted, marker delivered in the `Answer to
question ...` follow-up turn. Any scenario failure is actionable.
