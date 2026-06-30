# crates/pragma-cli - pragma-cli

CLI for Pragma host/client utilities and external agent status reporting. The
binary name is `pragma-cli` (not bare `pragma`, which collides with the app
crate's debug binary).

## Current Usage

```sh
pragma-cli agent report --agent <id> started|stopped|attention|cleared
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
reads the `Hello` frame, writes one `AgentReport` frame, and exits after the
frame is sent.

## Staging

The built binary is staged to
`apps/pragma/src-tauri/binaries/pragma-cli-<triple>` by
`apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh` and bundled as a Tauri
sidecar. The app installs/updates it to `~/.local/bin/pragma-cli` on startup.

## Future Scope

Most GUI-required commands broker through the running app via `pragma-server`.
Commands that do not need the app (`tab read`, `agent status`, and
`agent report`) talk directly to the server.
