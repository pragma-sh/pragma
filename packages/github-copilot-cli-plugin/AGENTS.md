# packages/github-copilot-cli-plugin - @pragma/github-copilot-cli-plugin

Self-contained GitHub Copilot CLI integration. Copilot CLI has no in-process lifecycle
plugin API; its native plugin hooks invoke `hooks/report.sh`, while TypeScript defines
Pragma launcher, watcher, model metadata, and usage-limit provider.

## File map

```
packages/github-copilot-cli-plugin/
├── assets/copilot.png       # Official product artwork from GitHub's CLI package
├── hooks/hooks.json         # Native Copilot lifecycle hooks
├── hooks/report.sh          # Hook payload -> pragma-cli state machine
├── plugin.json              # Copilot CLI plugin manifest
├── scripts/install-local.sh # Local Copilot plugin install
├── src/pragma-plugin.ts     # Launcher, watcher, models, and usage declaration
├── src/usage-limits.ts      # Copilot runtime quota transport + normalization
└── test/report.test.ts      # Fake-pragma-cli hook tests
```

## Tested host surface

Tested against GitHub Copilot CLI `1.0.75` on 2026-07-26. Official references:

- Hooks: https://docs.github.com/en/copilot/reference/hooks-reference
- Plugins: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
- CLI source/distribution: https://github.com/github/copilot-cli

Copilot plugins support command hooks but do not run arbitrary in-process TypeScript.
Plugin hooks receive native camelCase payloads. `${PLUGIN_ROOT}` resolves the installed
plugin copy. Reinstall after every hook or manifest change because Copilot caches local
plugins.

Copilot 1.0.75 can fire `userPromptSubmitted` before `sessionStart` in a fresh interactive
session. Session-start cleanup compares session ownership and preserves an already-active
turn for that same session. Unconditional cleanup makes verification settle and kill the
agent before its first model response.

## Lifecycle mapping

| Copilot hook          | Script event     | Pragma behavior                                                         |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `sessionStart`        | `session-start`  | Clears stale state unless same session's first turn already started     |
| `sessionEnd`          | `session-end`    | Clears status and all state on normal exit, crash, or session abort     |
| `userPromptSubmitted` | `started`        | Reports running, user message, and first-prompt-derived session name    |
| `agentStop`           | `stopped`        | Reports done only after a start and when no tracked child remains       |
| `subagentStart`       | `subagent-start` | Tracks transcript-scoped child, reports rich child count, stays running |
| `subagentStop`        | `subagent-stop`  | Removes matching child; parent `agentStop` owns done                    |
| `permissionRequest`   | `permission`     | Reports command attention and waits briefly for remote decision         |
| `postToolUse*`        | `running`        | Reasserts running after success or failure                              |
| `errorOccurred`       | `error`          | Keeps recoverable errors running; clears nonrecoverable failures        |

Hook reporter uses local agent id `github-copilot`, not catalog id
`pragma.github-copilot`. It exits immediately outside Pragma and swallows every reporting
failure. Active-turn marker prevents bare `agentStop` from creating phantom done state.
Watcher-owned process exit also reports `cleared`, covering termination paths where host
hooks cannot run.

Copilot does not expose current turn's transcript path on `userPromptSubmitted`, nor a
turn-abort hook. `sessionEnd(reason: "abort")` covers whole-session termination but not
Escape interruption of one turn. `abort` and `interrupt` stay explicitly excluded until
a versioned, turn-scoped signal is empirically verified.

## Decisions and questions

`permissionRequest` runs before Copilot's own permission service, including for tools its
native rules later auto-allow. Reporter silently defers known read-only utilities (`date`,
`pwd`, `whoami`, `uname`) to native evaluation so they do not create false attention. Other command requests report
structured command attention, wait up to `PRAGMA_APPROVAL_TIMEOUT` (default 15 seconds),
and emit Copilot's native `{ "behavior": "allow" | "deny" }` response. Both decisions
reassert started before returning. Timeout emits nothing, preserving native permission UI.

Copilot 1.0.75 emits no hook for `ask_user`, despite listing it in hook tool names. The
turn-owned transcript watcher reports each `tool.execution_start` whose tool name is
`ask_user` as question attention, including optionless free-form schemas and enum choices.
It snapshots the existing question count when a turn starts and advances a session-level
cursor, so resumed sessions and polling do not replay old questions. Remote answer delivery
is not supported: Copilot's form requires arrow navigation while shared watcher kit's listed
answers use digit shortcuts. Keep `questions` in `excludeFeatures`; native Copilot question
UI remains unchanged.

Same transcript watcher streams completed non-empty `assistant.message` content during turn,
deduped by per-turn count. Transcript path is host-private and must be reverified on every
tested-version bump. User-prompt hook provides stable session id but no transcript path;
current Copilot location is derived from that id.

## Usage limits

Usage provider launches short-lived `copilot --headless --stdio`, performs its JSON-RPC
`connect` handshake, then calls `account.getQuota`. Copilot CLI owns Keychain/Linux credential
reads, OAuth refresh, and quota transport, so Pragma never reads or prints tokens and does not
depend on GitHub CLI authentication. `quotaSnapshots.premium_interactions` is preferred for
legacy billing; token-billed accounts fall back to `quotaSnapshots.chat`. Either becomes one
AI-credits limit with its reset time. Copilot 1.0.75 reports `resetDate` as the current
30-day cycle's start; elapsed/current values advance to the next 30-day boundary, while a
future reset date is used directly. Missing Copilot CLI returns `not-configured`; missing
Copilot login returns `authentication-required`; valid responses without a usable allowance
return `unsupported`; transport and malformed framing failures throw so host preserves its last
snapshot. Reverify RPC and response shape on each tested Copilot CLI bump.
Plugin bundles run in WebKit, not Node. Keep quota framing browser-compatible (`TextEncoder` /
`TextDecoder`); a top-level Node global such as `Buffer` prevents the whole plugin from loading.
Run the quota subprocess through the user's login-interactive shell. GUI-launched Pragma does not
inherit fnm/nvm's version-specific `PATH`, while Copilot terminal sessions do; probing only the
host process `PATH` falsely reports an installed Copilot CLI as missing.

## Branding

`assets/copilot.png` is copied byte-for-byte from GitHub's signed npm distribution,
`@github/copilot-darwin-arm64@1.0.71/assets/copilot.png`, retrieved 2026-07-26. Package points
to vendor-controlled repository https://github.com/github/copilot-cli and carries GitHub's
`SEE LICENSE IN LICENSE.md` terms. Asset is Copilot product artwork, not a third-party icon.

GitHub's current brand page says standalone Copilot icon was deprecated in 2025 and product
lockups should be used where GitHub context is absent:
https://brand.github.com/brand-identity/copilot. This package uses vendor-shipped CLI artwork
only inside Pragma's explicitly named GitHub Copilot integration and must not imply GitHub
endorsement. Do not trace, recolor, or replace it with icon-aggregator artwork.

## Build, install, verify

```bash
bun run --filter @pragma/github-copilot-cli-plugin build
bun run --filter @pragma/github-copilot-cli-plugin install:local
copilot plugin list
```

Production builds bundle this package into Pragma's plugin resources. For local development,
register package's absolute path in `~/.pragma/config.json`. Rebuild bundle and reload Pragma
plugin host after edits. Then run:

```bash
bun run --filter @pragma/github-copilot-cli-plugin test
bun run --filter @pragma/github-copilot-cli-plugin typecheck
pragma-cli agent verify --agent pragma.github-copilot --abort-input '\x1b' --include-slow
```

Verifier skips explicitly unsupported question and abort/interrupt scenarios. Command approval,
subagents, session naming, usage limits, stream integrity, and crash cleanup remain required.
