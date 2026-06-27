# crates/pragma-cli - pragma-cli

CLI for Pragma host/client utilities and external agent status reporting. The
binary name is `pragma-cli` (not bare `pragma`, which collides with the app
crate's debug binary).

## Current Usage

```sh
pragma-cli --agent <id> report started|stopped|attention|cleared
```

| Status      | Dot color | Meaning                          |
| ----------- | --------- | -------------------------------- |
| `started`   | yellow    | Agent is running                 |
| `stopped`   | green     | Finished - go look at the output |
| `attention` | red       | Needs input / permission         |
| `cleared`   | -         | Remove the indicator entirely    |

`cleared` is distinct from `stopped`: use it when an agent exits without a
meaningful result to show.

## How It Works

The CLI reads `PRAGMA_SERVER_SOCKET` first, falling back to the legacy
`PRAGMA_DAEMON_SOCKET` during the transition. It also reads `PRAGMA_TAB_ID` and
`PRAGMA_WORKTREE_ID`, connects to the existing `pragma-server` Unix socket,
reads the `Hello` frame, writes one `AgentReport` frame, and exits without
waiting for an ack.

## Staging

The built binary is staged to
`apps/pragma/src-tauri/binaries/pragma-cli-<triple>` by
`apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh` and bundled as a Tauri
sidecar. The app installs/updates it to `~/.local/bin/pragma-cli` on startup.

## Future Scope

This crate is also the future home for general-purpose Pragma CLI functions such
as router DB management, host management, connect, and bootstrap. Do not add new
subcommands for the remote-server rearchitecture unless explicitly requested.
