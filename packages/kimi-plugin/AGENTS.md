# packages/kimi-plugin — @pragma-sh/kimi-plugin

Kimi Code CLI plugin that reports agent status into Pragma. Kimi has **no in-process JS
plugin API** — its only live extension point is shell-command hooks — so this is the
**CLI route, not the SDK**: a real Kimi plugin (`kimi.plugin.json` + `hooks/report.sh`)
where every hook shells out to a single bundled script that calls `pragma-cli`. (The TS
here defines the Pragma-side agent, model provider, and watcher; Kimi never loads it.)

Kimi installs plugins through its own mechanism: `/plugins install <local-path-or-zip-url>`
in the Kimi TUI (a third-party trust prompt then copies the plugin into
`~/.kimi-code/plugins/managed/<id>/`). There is no `kimi plugins` CLI. After editing,
run `bun run --filter @pragma-sh/kimi-plugin install:local`; it rebuilds the Pragma bundle,
replaces Kimi's managed snapshot, and updates `installed.json` without dropping other
plugins or the existing enabled state. Run `/plugins reload` or start a new Kimi session.

On the Pragma side, add the package to `~/.pragma/config.json` `plugins[]` (or a project
`.pragma/config.json`) so the catalog sidecar resolves the agent; the plugin is then
launchable without bundling it into app resources.

## File map

```
packages/kimi-plugin/
├── assets/                  # Kimi brand asset used by the built-in launcher
├── src/pragma-plugin.ts     # Agent, model provider, and watcher declaration
├── src/models.ts            # Reads models through `kimi provider list`
├── scripts/install-local.ts # Rebuild-safe Kimi managed-snapshot installer
├── kimi.plugin.json         # Kimi plugin manifest with the hooks array
├── hooks/report.sh          # Event → pragma-cli translator (the actual logic)
└── test/report.test.ts      # Drives report.sh with a fake pragma-cli on PATH
```

Each hook in `kimi.plugin.json` invokes `sh "$KIMI_PLUGIN_ROOT/hooks/report.sh" <verb>`.
`KIMI_PLUGIN_ROOT` is exported by Kimi for plugin hooks (and `cwd` is set to the plugin
root); running through `sh` means the script works regardless of its executable bit.

## Hook → status mapping

| Hook                             | `report.sh` arg  | Reports                                                                                                                                                                                                        |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                   | `cleared`        | `cleared` status (+ tears down stale state)                                                                                                                                                                    |
| `SessionEnd`                     | `cleared`        | `cleared` status (+ forgets the session pin and name)                                                                                                                                                          |
| `UserPromptSubmit`               | `started`        | `started` + user prompt message + `session-name` (once per `session_id`, from the first prompt)                                                                                                                |
| `Stop`                           | `stopped`        | `stopped` + the turn's reply text read from the session transcript (`agents/main/wire.jsonl`) when available; a coarse completion message otherwise (only on genuine completion — Kimi skips Stop for cancels) |
| `StopFailure`                    | `failed`         | `cleared` (+ system note with the error)                                                                                                                                                                       |
| `Interrupt`                      | `interrupted`    | `cleared` (+ system note) — Kimi's native user-cancel hook, so **no transcript watcher is needed**                                                                                                             |
| `SubagentStart`                  | `subagent-start` | Increments the active-child count and re-asserts `started`                                                                                                                                                     |
| `SubagentStop`                   | `subagent-stop`  | Decrements the active-child count; final status stays owned by the parent `Stop`                                                                                                                               |
| `PostToolUse`                    | `running`        | `started` **iff** a turn's marker exists; else nothing                                                                                                                                                         |
| `PermissionRequest`              | `permission`     | `attention --kind command` (+ command text + request-id) **iff** a marker exists                                                                                                                               |
| `PreToolUse` (`AskUserQuestion`) | `question`       | `attention --kind question` (+ question text + request-id; generic fallback text when the payload has no single question) **iff** a marker exists                                                              |

Statuses: `started` = yellow running dot, `stopped` = green done dot, `attention` = red
needs-input dot, `cleared` = remove the dot. `cleared` is deliberately used for both
`failed` and `interrupted` — a cancelled turn has no meaningful "done" result to show.

**Subagent accounting is a count, not per-child markers.** Kimi subagents share the parent
`session_id` and add no distinguishing field; parallel subagents even share the default
profile name (`coder`), so there is no stable per-child id across `SubagentStart`/
`SubagentStop` to key markers on. `report.sh` therefore keeps one active-child count,
mutated under a `mkdir`-based exclusive lock (POSIX sh has no atomic increment, but POSIX
guarantees `mkdir` is atomic, so counting needs no interpreter). Content-bearing messages
(the user's prompt, tool output, question/command text) still need real JSON
parsing/escaping that POSIX sh can't do safely; those go through `node`, not `python3` —
Kimi itself ships as an npm package, so any machine that can run `kimi` already has a
working `node` on PATH. Without `node` those helpers degrade to coarse status-only
messages; subagent counting is unaffected either way.
A `Stop`/`StopFailure` arriving while the count is non-zero is a subagent turn ending —
never a parent completion — so the tab stays on `started` until the parent's own `Stop`.

## Why no abort watcher (unlike claude/grok)

Claude Code and Grok fire **no hook on user cancel**, so their `report.sh` scripts spawn a
detached background watcher that polls the transcript for the interrupt marker. Kimi is
different: `Interrupt` fires natively when the TUI's Esc/Ctrl+C cancels the running turn
(the RPC `session.cancel()` path), and `Stop` does **not** fire on a cancel — only on
genuine completion. `StopFailure` covers API/step errors. Every terminal state has a
first-class hook, so `report.sh` here is purely event-driven and holds no watcher.

## Hook input envelope (snake_case)

Kimi pipes one JSON line to the hook's stdin, with keys converted to snake_case (the same
convention as Claude Code, unlike Grok's camelCase):

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "session_<uuid>",
  "cwd": "<project>",
  "prompt": [{ "type": "text", "text": "..." }],
  "is_steer": false
}
```

`prompt` on `UserPromptSubmit` is a `ContentPart[]` array, not a string — `report.sh`
joins the `text` parts. `Stop` carries only `{ "stop_hook_active": false }` (no reply
text), so the plugin reports status-only messages for completions rather than streaming
the assistant's reply. Hooks exit 0 to allow; the blocking `PreToolUse` hook must always
exit 0 so it never denies a tool.

## Permissions and questions

Kimi's `PermissionRequest` hook is fire-and-forget: the approval answer comes from Kimi's
own TUI (`requestApproval` RPC), never from a hook result, so there is no
`await-decision` round-trip. `AskUserQuestion` is auto-approved and rendered by the TUI's
own question UI, so a `question`/`command` attention is raised for the user to look at the
terminal and answer there. Question attention includes every option (or the complete
multi-question array) and a generated request id. The Pragma watcher answers Kimi's native
dialog directly: digits choose listed answers, Other uses arrow/Enter navigation, and `1`
confirms Kimi's final review tab. It never aborts the turn or injects a synthetic chat
message. Background questions are intentionally not reported because they do not block the
TUI. `PostToolUse` (the `running` verb) re-asserts `started` the moment the turn continues,
dropping the attention back to "in progress". The watcher keeps `handleDecisions: false`
because permission requests still have no brokered round-trip.

## Model provider

Kimi's model catalog is remote and user-configured. `src/models.ts` queries Kimi's
supported `provider list --json` / `provider list` CLI through `ctx.sdk.exec.run`, maps
aliases to launcher entries, and immediately drops provider data (including credentials).
The queries fall back to `$HOME/.kimi-code/bin/kimi` (the official installer's location)
when the CLI is not on the subprocess PATH — a GUI-launched host does not read `.zshrc`,
so `~/.kimi-code/bin` is absent from its shell PATH unless the host adds it (see
`process_env` in pragma-core, which includes it).
Do not import `node:fs` or read `~/.kimi-code/config.toml` directly: the same bundle loads
inside the production desktop webview, where Node built-ins make the whole plugin fail,
and direct local reads target the wrong machine for remote projects. Aliases marked
`disabled` are dropped during parsing — Kimi rejects them at launch, so offering one in
the picker only produces a session that fails to start, and a disabled default would
otherwise become the launcher's first entry. The configured default model comes first;
without one, declaration order is preserved. Do not
alphabetize this list: `agent verify` defaults to its first entry, and alphabetizing
previously selected a stale `Big Pickle` alias that never completed. Kimi has no
reasoning-effort flag (`-m` takes an alias only), so entries carry no `reasoning` list.
When Kimi cannot be queried, the launcher still opens without a model picker.

## Verification

```bash
bun run --filter @pragma-sh/kimi-plugin install:local
bun run --filter @pragma-sh/kimi-plugin test
bun run --filter @pragma-sh/kimi-plugin typecheck
pragma-cli agent verify --agent pragma.kimi --model <working-model-alias> --abort-input '\x1b'
```

Kimi installations can retain stale or provider-specific aliases. Pass a known-working
model explicitly for live verification; use at least a 120-second step timeout for free
models because parallel sub-agents can exceed 60 seconds.

## Launch

The base launch is `kimi -y` (yolo): Kimi's manual mode gates **Bash** behind a TUI
approval prompt (Bash is not in kimi's default-approve tool set), so a plain `kimi` never
completes a safe shell command headlessly and `pragma-cli agent verify`'s
`command-no-permission` scenario times out. Baking `-y` into the base command mirrors
Claude Code's `--permission-mode auto`; `-y` auto-approves regular tool calls while the
agent may still ask questions. The declared permission modes are `yolo` = `-y` (default,
already in the base command), `default` = ask (no flag), `auto` = `--auto` (fully
autonomous), `plan` = `--plan` (plan mode). The host does not apply `permissionMode` args
yet, so the base command is the effective launch; when the selector gets wired, the base
`-y` and the per-mode args must be reconciled (an "ask" selection currently cannot strip
the baked-in `-y`). `--model <alias>` selects the model. Outside a Pragma terminal
`PRAGMA_SERVER_SOCKET`/`PRAGMA_DAEMON_SOCKET` are unset and every hook is a silent no-op
(exit 0), so the plugin is harmless in plain terminals.
