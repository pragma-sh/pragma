# `pragma-agent` CLI — the fallback plugin route

Helper CLI for external agents running inside a Pragma terminal to report their runtime
status. **Use this route only when the host tool has no in-process JS/TS plugin API** and
its only extension point is shell-command hooks (e.g. Claude Code). When a JS plugin API
exists, prefer [`@pragma/sdk`](./SDK.md) instead — it wraps this CLI with typed options.

Source: `crates/pragma-agent-cli/`. Real-world consumer:
`packages/claude-code-plugin/`. See [CREATE_PLUGIN.md](./CREATE_PLUGIN.md) for the full
workflow.

The Tauri app installs/updates the binary to `~/.local/bin` on startup (and warns in the
UI if that directory isn't on `$PATH`).

## Usage

```sh
pragma-agent --agent <id> report started
pragma-agent --agent <id> report stopped
pragma-agent --agent <id> report attention [--kind question|command]
pragma-agent --agent <id> report cleared
```

`--agent <id>` comes **before** the `report` subcommand. `<id>` is the stable agent id
from your `pragma/agents/<id>/config.json`.

| Status      | Dot color | Meaning                              |
| ----------- | --------- | ------------------------------------ |
| `started`   | yellow    | Agent is running                     |
| `stopped`   | green     | Finished — go look at the output     |
| `attention` | red       | Needs input / permission             |
| `cleared`   | —         | Remove the indicator entirely        |

`cleared` is distinct from `stopped`: use it when the agent process exits without a
meaningful result to show (user quit, crash, abort). `stopped` is the green "done" signal
and should only follow a `started`.

### Flags

- `--kind question|command` *(optional, `report attention` only)* — hint for the kind of
  attention. Omit it when the host can't tell question vs. command; Pragma then shows a
  generic attention indicator.
- `--worktree-id <id>` *(optional, `report stopped` / `report cleared`)* — overrides
  `PRAGMA_WORKTREE_ID`, useful when reporting final status from a parent process.

## How it works

The CLI reads `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, and `PRAGMA_DAEMON_SOCKET` from the
environment (injected by the daemon when it spawns a terminal session). It connects to
the existing daemon socket, reads the `Hello` frame, writes one `AgentReport` frame, and
exits without waiting for an ack.

## Writing a CLI-route plugin

Keep all logic in **one POSIX `sh` script** that your tool's hooks invoke as
`sh "$PLUGIN_ROOT/hooks/report.sh" <event>`. Two non-negotiable rules — both shown in
`packages/claude-code-plugin/hooks/report.sh`:

1. **No-op outside Pragma.** The plugin runs in every session of the host tool, so guard
   at the top:

   ```sh
   [ -n "${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0
   ```

2. **Never disrupt the host session.** Wrap every CLI call so a missing binary or down
   daemon can't fail the hook:

   ```sh
   report() {
     pragma-agent --agent "$agent" report "$@" >/dev/null 2>&1 || true
   }
   ```

Translate each verified host event to one `report …` call, mapping to the four statuses
above. Keeping the logic in a script (not inline JSON one-liners) is what makes the
tricky cases — especially abort handling — testable.

### Abort handling

If the host tool fires **no hook** when a turn is cancelled (Claude Code does not — verified
empirically), a hook-only bridge can never observe the cancel and the tab stays stuck.
The Claude Code plugin solves this by spawning a detached background watcher on `started`
that polls the session transcript for the interrupt marker and reports `cleared` the moment
this turn's tail shows it. Read `packages/claude-code-plugin/AGENTS.md` for the full
state-machine, marker/pidfile, and offset-pinning details before copying it — the edge
cases (stale markers, new turns mid-poll, SIGKILL backstops) are subtle.

## Testing

Drive the script with a fake `pragma-agent` on `PATH` and assert the emitted argv. See
`packages/claude-code-plugin/test/report.test.ts`.

## JS/TS consumers

Use [`@pragma/sdk`](./SDK.md) instead of hand-building argv whenever you can — it wraps
this CLI with typed options and is bundled as ESM, CJS, and `.d.ts`.
