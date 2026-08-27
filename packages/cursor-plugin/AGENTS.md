# packages/cursor-plugin — @pragma-sh/cursor-plugin

Static Cursor Agent CLI integration that reports agent status into Pragma. Cursor has
**no in-process JS plugin API** for status — its extension point is **shell hooks**
(`~/.cursor/hooks.json`) — so this is the **CLI route**: hooks invoke a single bundled
`hooks/report.sh` that calls `pragma-cli`.

## File map

```
packages/cursor-plugin/
├── src/pragma-plugin.ts       # Agent, watcher, and usage-limit declarations
├── assets/
│   ├── cursor.svg            # Cursor brand asset used by the built-in launcher
│   └── usage-limits-cli.ts   # CLI-authenticated Cursor usage-summary fetcher source
├── hooks/
│   ├── report.sh              # Event → pragma-cli translator
│   └── hooks.fragment.json    # Hook entries merged by install-local.sh
├── scripts/install-local.sh   # Local install (hooks + cli-config defaults)
└── test/report.test.ts
```

## Why `cursor-agent` (no wrapper CLI)

The first version used a separate `pragma-cursor-agent` launcher with `expect` to send
**`a`** / **`n`** through the interactive **Command Execution** intro. That intro is
not a permission gate Cursor exposes only via keystrokes — it is skipped when
`~/.cursor/cli-config.json` already has the same settings the intro would write:

| Intro choice               | Persisted config                                       |
| -------------------------- | ------------------------------------------------------ |
| **`a`** Auto sandbox       | `sandbox.mode: "enabled"`, `approvalMode: "allowlist"` |
| **`n`** No sandbox network | `sandbox.networkAccess: "user_config_with_defaults"`   |
| (done)                     | `showSandboxIntro: false`                              |

`install-local.sh` merges those defaults into:

- `~/.cursor/cli-config.json` — CLI agent config (`approvalMode`, `sandbox`, `permissions.allow`)
- `~/.cursor/permissions.json` — shared IDE + CLI allowlists (`approvalMode`, `mcpAllowlist`, `terminalAllowlist`; CLI reads this since 2026-03)
- `<git-root>/.cursor/permissions.json` — project IDE/CLI allowlists
- `<git-root>/.cursor/cli.json` — project CLI permission allow/deny only (no `approvalMode` / `sandbox`; those stay global)

The Pragma launcher starts Cursor's unambiguous binary name:

```json
"start": ["cursor-agent", "--force", "--approve-mcps"]
```

- **`--force`** (`--yolo`) — Run Everything: auto-approve commands unless explicitly
  denied (matches intro option **`u`** / `approvalMode: "unrestricted"`).
- **`--approve-mcps`** — skips the MCP approval prompt at session start.

Do not shorten this to `agent`: unrelated tools install that generic binary name. Model
discovery and launch must both target `cursor-agent`, or Pragma can catalog Cursor models
while launching a different agent.

Per-command allowlist prompts should not appear with `--force`. To use Auto sandbox +
allowlist instead, drop `--force` and use `--sandbox enabled` with
`approvalMode: "allowlist"` in `cli-config.json`.

## Hook → status mapping

| Cursor hook          | `report.sh` arg | Reports                                                                   |
| -------------------- | --------------- | ------------------------------------------------------------------------- |
| `sessionStart`       | `cleared`       | `cleared` (fresh session; clears stale dots)                              |
| `sessionEnd`         | `cleared`       | `cleared`                                                                 |
| `beforeSubmitPrompt` | `started`       | `started` + user prompt message; first prompt also derives `session-name` |
| `afterAgentResponse` | `response`      | Assistant response message                                                |
| `stop`               | `stopped`       | `stopped`; `cleared` when Cursor reports `aborted` or `error`             |
| `postToolUse`        | `running`       | `started` **iff** turn marker exists (clears stale red)                   |

## Command approval is unsupported

Cursor fires `beforeShellExecution` / `beforeMCPExecution` for every tool execution,
including safe auto-approved commands under `--force`; payloads do not distinguish a real
permission prompt. Wiring them as attention hooks makes `date +%s` falsely block for remote
approval. Keep those events out of `hooks.fragment.json` and declare `commandApproval`
unsupported until Cursor exposes a prompt-only signal.

## Interjection (free-form input)

Interjections (`AgentInput`, e.g. the SDK's `client.agents.connect(...).send(text)`) are **not**
handled by these hooks. Cursor is a PTY TUI with no mid-turn input hook, so the shared
watcher delivers the text by writing it into the live terminal, waiting briefly for Cursor's
paste-aware input to commit it, then writing Enter separately. Sending text and `\r` in one PTY
write leaves Cursor's reply unsubmitted. This plugin's hooks stay approval-only.

## AskQuestion — OSC title signal

Interactive questions (Cursor's **AskQuestion** tool) have no hook or transcript signal,
confirmed
empirically against Cursor Agent CLI `2026.06.19` and the [Cursor hooks docs](https://cursor.com/docs/hooks):

- **No question hook.** Claude Code raises generic `attention` from `PermissionRequest`
  / `Elicitation` the instant a prompt appears. Cursor exposes **no equivalent** —
  only `beforeShellExecution` / `beforeMCPExecution` for command-style gates. `preToolUse`
  is documented for "all tools" but **does not fire for AskQuestion**.
- **No file signal.** A transcript watcher (the pattern Claude Code's abort handling
  uses) cannot help here: while a question is pending, Cursor writes **nothing** to the
  session transcript — the JSONL stays at just the user-prompt line, and the assistant's
  AskQuestion `tool_use` is only flushed **after** the user answers. Verified live: the
  transcript sat at exactly one line for the entire time the agent was blocked on a
  question. There is no other on-disk state to poll either.
- **The PTY title carries it.** While blocked, Cursor sets the terminal title via an
  OSC sequence (`Choice Asker` / `Ask Question` vs `Cursor Agent`). A hook subprocess
  cannot see the PTY stream, but the plugin watcher receives decoded session output.
  It reports generic question attention when either question title appears and restores
  running when `Cursor Agent` returns. Prompt/options remain unavailable, so remote answer
  controls are not offered; status still accurately shows that Cursor needs attention.

**If Cursor ships a question hook** (e.g. `preToolUse` firing for AskQuestion, or a
dedicated event), wire it in `hooks.fragment.json` to a new `report.sh` case that calls
`agent report --agent cursor attention --kind command`-style with `--kind question`, guarded on the marker —
that is the whole fix at that point.

**Abort/cancel handling:** also not bridged. Not yet verified empirically for Cursor
Agent CLI; see `packages/claude-code-plugin/AGENTS.md` if transcript polling for cancels
is wanted later (it relies on Cursor writing an interrupt marker to the transcript,
which has not been confirmed).

Process exit is observable through the exact launched-session watcher. Its `finally`
reports `cleared`, covering crashes and kills that skip Cursor's `sessionEnd` hook;
reporting failures are swallowed so cleanup cannot disrupt watcher shutdown.

Cursor exposes no reliable native session title in hook payloads. `report.sh` derives one
from the first prompt's first nonblank line (47 characters plus `…` when truncated), reports it once per
session, and resets that state on `sessionStart` / `sessionEnd`.

The built-in launcher cannot expose question contents/answers, prompt-only command approval,
subagent lifecycle, abort detection, or interrupt handling, so the latter four are declared in
`excludeFeatures`. `agent verify` skips those unsupported scenario groups instead of
treating known host limitations as failures.

## Installation

```bash
bun run --filter @pragma-sh/cursor-plugin install:local
```

This copies hooks to `~/.pragma/plugins/cursor/hooks/`, merges hook entries into
`~/.cursor/hooks.json`, and updates CLI + permissions settings (see above).
It also installs the bundled Node usage helper under `~/.pragma/plugins/cursor/scripts/`; the helper
reuses `cursor-agent login` credentials and never persists or prints access tokens.
Re-run after updating the package. Removes legacy launcher assets if present.

Usage refreshes every five minutes. Authentication failures ask for login; endpoint rate
limits, redirects, and transport failures render as temporarily unavailable and retry instead
of exposing raw helper errors in Settings. Commands rely on the host-selected shell and must
not nest `/bin/sh`, which is absent on Windows.

If install fails with "cannot write" inside a sandboxed agent, run the same command
in a normal terminal (writes go to `~/.pragma` and `~/.cursor`).

Launch from Pragma's agent menu via the built-in Cursor agent, or run
`cursor-agent --force --approve-mcps` in a Pragma terminal.

## Guard + non-Pragma sessions

`report.sh` exits 0 when `PRAGMA_DAEMON_SOCKET` is unset. Hooks live in user-scope
`~/.cursor/hooks.json`, so the env guard is mandatory. Inside Pragma, sessions export
`PRAGMA_CLI=$HOME/.local/bin/pragma-cli`; `report.sh` uses that absolute path before
falling back to `pragma-cli` from `PATH`.

## Built-in launcher

The launchable Cursor entry is defined **here** in `src/pragma-plugin.ts`. This is now
the single source of truth: the `pragma-plugins` catalog sidecar
(`@pragma/plugins-host`) imports it directly to assemble the agent catalog, and
`apps/pragma/src/plugins/builtin-agents.ts` re-exports it (overriding `iconPath` with a
browser URL and attaching the built-in watcher) so the webview path shares the same
definition.

Its icon asset stays in this package under `assets/`, not in Pragma core.

- `startupInput: [{ delayMs: 5000, data: "a" }]` accepts Cursor's TUI workspace-trust
  gate for new git worktree paths.
- `prefillDelayMs: 14000` waits for the real Cursor Agent TUI input before prompt paste.
- `prefillMode: "plain"` pastes the prompt unbracketed; the prompt's own `\n`s are
  inserted as newlines (Cursor's TUI only submits on a parsed `return` key, not on a
  raw line feed), so multi-line prompts stay intact.
- `prefillSubmit: "\\r"` submits with a plain carriage return. Cursor's TUI input parser
  treats Shift+Enter CSI-u/`modifyOtherKeys` sequences (`[13;2u`, `[27;2;13~`, …) as
  newline insertion and only submits when the key parses to `return` — i.e. a bare `\r`.
  An earlier Ctrl+Enter sequence (`\\u001b[13;5u`) was **not** decoded as `return`, so the
  prompt pasted but never sent.

These are agent-owned keystrokes/timing, not Pragma core Cursor branches. User-defined
agents can use the same fields for their own pre-TUI gates. Model discovery runs
`agent models` from the built-in plugin model provider and parses Cursor-specific output
there, not in Rust/Tauri IPC.

## Known gotchas

1. Cursor Agent CLI reads hooks from **`~/.cursor/hooks.json`** (user scope).
2. Hook event names are **camelCase** (`sessionStart`, `beforeSubmitPrompt`, …).
3. **Workspace trust** for a new directory is separate from the sandbox intro; Cursor
   worktrees may inherit trust from the main checkout (see Cursor CLI changelog). Use
   `--force` only if you intentionally want headless-style trust + run-everything
   behavior in interactive sessions.
