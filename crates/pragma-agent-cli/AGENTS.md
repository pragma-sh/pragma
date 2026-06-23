# crates/pragma-agent-cli — pragma-agent CLI

Helper CLI (`pragma-agent`) for external agents running inside a Pragma terminal to
report their runtime status. The Tauri app installs/updates it to `~/.local/bin` on
startup and emits a UI warning if that directory is not on `$PATH`.

## Usage

```sh
pragma-agent --agent <id> report started|stopped|attention|cleared
```

| Status      | Dot color | Meaning                          |
| ----------- | --------- | -------------------------------- |
| `started`   | yellow    | Agent is running                 |
| `stopped`   | green     | Finished — go look at the output |
| `attention` | red       | Needs input / permission         |
| `cleared`   | —         | Remove the indicator entirely    |

`cleared` is distinct from `stopped` — use it when the agent process exits without a
meaningful result to show (e.g. user quit, crash, abort).

## How it works

The CLI reads `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, and `PRAGMA_DAEMON_SOCKET` from
the environment (injected by the daemon when spawning a terminal session). It connects
to the existing daemon socket, reads the `Hello` frame, writes one `AgentReport` frame,
and exits without waiting for an ack.

## JS/TS consumers

Use `@pragma/sdk` (`packages/sdk`) instead of hand-building argv. It wraps this CLI
with typed options and is bundled as ESM, CJS, and `.d.ts`.

## Staging

The built binary is staged to `apps/pragma/src-tauri/binaries/pragma-agent-<triple>` by
`apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh` and bundled as a Tauri
sidecar. `binaries/` is git-ignored.
