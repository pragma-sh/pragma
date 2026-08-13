# `pragma-cli` CLI — the fallback plugin route

Helper CLI for external agents running inside a Pragma terminal to report their runtime
status. **Use this route only when the host tool has no in-process JS/TS plugin API** and
its only extension point is shell-command hooks (e.g. Claude Code). When a JS plugin API
exists, prefer [`@pragma/sdk`](./SDK.md) instead — it wraps this CLI with typed options.

Source: `crates/pragma-cli/`. Real-world consumer:
`packages/claude-code-plugin/`. See [CREATE_PLUGIN.md](./CREATE_PLUGIN.md) for the full
workflow.

The Tauri app installs/updates the binary to `~/.local/bin` on startup (and warns in the
UI if that directory isn't on `$PATH`).

## Usage

```sh
pragma-cli scratchpad create --title "Architecture" result.mdx
pragma-cli agent report --agent <id> started
pragma-cli agent report --agent <id> stopped
pragma-cli agent report --agent <id> attention [--kind question|command]
pragma-cli agent report --agent <id> cleared
```

`scratchpad create` is the managed path for presenting editable, interactive MDX to the
user. It copies source into `.pragma/scratchpads/`, excludes that local directory from
Git, records the current agent tab from `PRAGMA_TAB_ID`, and opens the result. Use `-` as
the file argument to read MDX from stdin. Do not create scratchpad files manually: the
desktop requires command-generated frontmatter.

`--agent <id>` belongs to the `agent report` command. `<id>` is the stable id from the
matching Pragma plugin agent definition.

| Status      | Dot color | Meaning                          |
| ----------- | --------- | -------------------------------- |
| `started`   | yellow    | Agent is running                 |
| `stopped`   | green     | Finished — go look at the output |
| `attention` | red       | Needs input / permission         |
| `cleared`   | —         | Remove the indicator entirely    |

`cleared` is distinct from `stopped`: use it when the agent process exits without a
meaningful result to show (user quit, crash, abort). `stopped` is the green "done" signal
and should only follow a `started`.

### Flags

- `--kind question|command` _(optional, `report attention` only)_ — hint for the kind of
  attention. Omit it when the host can't tell question vs. command; Pragma then shows a
  generic attention indicator.
- `--worktree-id <id>` _(optional, `report stopped` / `report cleared`)_ — overrides
  `PRAGMA_WORKTREE_ID`, useful when reporting final status from a parent process.

## Fanout

`pragma-cli fanout` runs one prompt in several isolated attempt worktrees under
one parent, then keeps one of them. It talks straight to `pragma-server`, so it
works with the desktop app closed.

```sh
# The current worktree is the parent; at least two --agent selectors are required.
pragma-cli fanout create "Implement token refresh and tests" \
  --reasoning high \
  --agent opencode \
  --agent claude-code

# Explicit parent, per-selector model and reasoning effort.
pragma-cli fanout create --parent "$PRAGMA_WORKTREE_ID" "Implement token refresh" \
  --agent 'opencode.openai/gpt-5.6.high' \
  --agent 'claude-code.claude-opus-4-1.max'

# Create a coordination parent first, prompt from a file (`-` reads stdin).
pragma-cli fanout create --new-parent fanout/token-refresh \
  --parent-title "Token refresh candidates" --from "$PRAGMA_WORKTREE_ID" \
  --prompt-file task.md --agent opencode --agent claude-code

pragma-cli fanout show [<id>] [--watch]
pragma-cli fanout read [<id>] --member <member-id> --lines 500
pragma-cli fanout read [<id>] --all --lines 100
pragma-cli fanout send [<id>] --all --message "Also include migration docs"
pragma-cli fanout retry [<id>] --member <member-id>
pragma-cli fanout cancel [<id>]
pragma-cli fanout pick [<id>] --member <member-id>
```

A selector is `agent[.model[.reasoning]]`, resolved as the longest catalog agent
prefix, then the remainder as an **exact** model id, and only then the final
segment as a reasoning effort — so a dotted model id like `openai/gpt-5.6` is
never mangled. Duplicate selectors are allowed: sampling one model twice is a
supported use. `--reasoning` sets a fanout-wide default that any selector can
override; a default no selected model offers rejects the whole create before
anything is provisioned.

There is no `fanout list`. A parent owns at most one active fanout, so an
omitted id resolves from `$PRAGMA_FANOUT_ID`, then from the current worktree —
as its parent, or as one of its attempts. `--member` defaults to
`$PRAGMA_FANOUT_MEMBER_ID`, which every attempt session exports, so an agent can
address its own attempt without being told which one it is.

`fanout pick` is destructive: it commits the winner's uncommitted work under an
AI-generated message, merges it into the parent, promotes its scratchpads, then
deletes **every** attempt worktree and branch, the winner included. It prints
that list and requires a typed `yes` unless `--yes` is passed.

## How it works

The CLI reads `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, and `PRAGMA_SERVER_SOCKET` (falling
back to legacy `PRAGMA_DAEMON_SOCKET`) from the environment injected into Pragma terminal
sessions. It connects to the existing server socket, reads the `Hello` frame, writes one
`AgentReport` frame, and exits after the frame is sent.

## Writing a CLI-route plugin

Keep all logic in **one POSIX `sh` script** that your tool's hooks invoke as
`sh "$PLUGIN_ROOT/hooks/report.sh" <event>`. Two non-negotiable rules — both shown in
`packages/claude-code-plugin/hooks/report.sh`:

1. **No-op outside Pragma.** The plugin runs in every session of the host tool, so guard
   at the top:

   ```sh
   [ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0
   ```

2. **Never disrupt the host session.** Wrap every CLI call so a missing binary or down
   server can't fail the hook:

   ```sh
   report() {
     pragma-cli agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
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

Drive the script with a fake `pragma-cli` on `PATH` and assert the emitted argv. See
`packages/claude-code-plugin/test/report.test.ts`.

## JS/TS consumers

Use [`@pragma/sdk`](./SDK.md) instead of hand-building argv whenever you can — it wraps
this CLI with typed options and is bundled as ESM, CJS, and `.d.ts`.
