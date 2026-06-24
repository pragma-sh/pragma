# packages/cursor-plugin — @pragma/cursor-plugin

Static Cursor Agent CLI integration that reports agent status into Pragma. Cursor has
**no in-process JS plugin API** for status — its extension point is **shell hooks**
(`~/.cursor/hooks.json`) — so this is the **CLI route**: hooks invoke a single bundled
`hooks/report.sh` that calls `pragma-agent`.

## File map

```
packages/cursor-plugin/
├── hooks/
│   ├── report.sh              # Event → pragma-agent translator
│   └── hooks.fragment.json    # Hook entries merged by install-local.sh
├── scripts/install-local.sh   # Local install (hooks + cli-config defaults)
├── test/report.test.ts
└── pragma/agents/cursor/config.json  # Bundled agent launcher config
```

## Why plain `agent` (no wrapper CLI)

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

The Pragma launcher then starts plain:

```json
"start": ["agent", "--force", "--approve-mcps"]
```

- **`--force`** (`--yolo`) — Run Everything: auto-approve commands unless explicitly
  denied (matches intro option **`u`** / `approvalMode: "unrestricted"`).
- **`--approve-mcps`** — skips the MCP approval prompt at session start.

Per-command allowlist prompts should not appear with `--force`. To use Auto sandbox +
allowlist instead, drop `--force` and use `--sandbox enabled` with
`approvalMode: "allowlist"` in `cli-config.json`.

## Hook → status mapping

| Cursor hook            | `report.sh` arg     | Reports                                                 |
| ---------------------- | ------------------- | ------------------------------------------------------- |
| `sessionStart`         | `cleared`           | `cleared` (fresh session; clears stale dots)            |
| `sessionEnd`           | `cleared`           | `cleared`                                               |
| `beforeSubmitPrompt`   | `started`           | `started` (sets the turn marker)                        |
| `stop`                 | `stopped`           | `stopped`                                               |
| `beforeShellExecution` | `attention-command` | `attention --kind command` (observe-only)               |
| `beforeMCPExecution`   | `attention-command` | `attention --kind command` (observe-only)               |
| `postToolUse`          | `running`           | `started` **iff** turn marker exists (clears stale red) |

`beforeShellExecution` / `beforeMCPExecution` exit 0 with **no stdout** so Cursor keeps
its normal approval UI (fail-open).

## AskQuestion — not reported (and why)

Interactive questions (Cursor's **AskQuestion** tool) are **intentionally not** bridged
to `attention --kind question`. There is no plugin-level signal to observe, confirmed
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
- **Only the PTY title carries it.** While blocked, Cursor sets the terminal title via an
  OSC sequence (`Choice Asker` / `Ask Question` vs `Cursor Agent`). A hook subprocess
  cannot see the PTY stream — only pragma's daemon/frontend, which owns the PTY, could.
  Wiring that up is a **core change** (out of plugin scope per the root `AGENTS.md`), so
  it is deliberately not done here.

**If Cursor ships a question hook** (e.g. `preToolUse` firing for AskQuestion, or a
dedicated event), wire it in `hooks.fragment.json` to a new `report.sh` case that calls
`report attention --kind command`-style with `--kind question`, guarded on the marker —
that is the whole fix at that point.

**Abort/cancel handling:** also not bridged. Not yet verified empirically for Cursor
Agent CLI; see `packages/claude-code-plugin/AGENTS.md` if transcript polling for cancels
is wanted later (it relies on Cursor writing an interrupt marker to the transcript,
which has not been confirmed).

## Installation

```bash
bun run --filter @pragma/cursor-plugin install:local
```

This copies hooks to `~/.pragma/agents/cursor/`, merges hook entries into
`~/.cursor/hooks.json`, and updates CLI + permissions settings (see above).
Re-run after updating the package. Removes legacy launcher assets if present.

If install fails with "cannot write" inside a sandboxed agent, run the same command
in a normal terminal (writes go to `~/.pragma` and `~/.cursor`).

Launch from Pragma's agent menu once `~/.pragma/agents/cursor/config.json` is installed
(app startup), or run `agent --force --approve-mcps` in a Pragma terminal.

## Guard + non-Pragma sessions

`report.sh` exits 0 when `PRAGMA_DAEMON_SOCKET` is unset. Hooks live in user-scope
`~/.cursor/hooks.json`, so the env guard is mandatory.

## Agent launcher config

`pragma/agents/cursor/config.json` — staged by `stage-daemon-sidecar.sh`.

## Known gotchas

1. Cursor Agent CLI reads hooks from **`~/.cursor/hooks.json`** (user scope).
2. Hook event names are **camelCase** (`sessionStart`, `beforeSubmitPrompt`, …).
3. **Workspace trust** for a new directory is separate from the sandbox intro; Cursor
   worktrees may inherit trust from the main checkout (see Cursor CLI changelog). Use
   `--force` only if you intentionally want headless-style trust + run-everything
   behavior in interactive sessions.
