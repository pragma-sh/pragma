# Pragma CLI Reference

Use `pragma-cli`, not `pragma`. Run `pragma-cli --help` and
`pragma-cli <group> <command> --help` for exact installed flags.

## Command Shape

```sh
pragma-cli [--json | --toon] <group> <command> ...
```

Default output is human-readable. Use `--json` for scripts or `--toon` for token-efficient
structured agent context. Both flags are global and mutually exclusive.

| Variable                  | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `PRAGMA_WORKTREE_ID`      | Current worktree and default for many `--worktree` flags. |
| `PRAGMA_TAB_ID`           | Current terminal tab and agent-report route.              |
| `PRAGMA_SERVER_SOCKET`    | Preferred direct connection to persistent host.           |
| `PRAGMA_DAEMON_SOCKET`    | Legacy server-socket fallback.                            |
| `PRAGMA_FANOUT_ID`        | Current fanout.                                           |
| `PRAGMA_FANOUT_MEMBER_ID` | Current fanout attempt.                                   |

## Worktrees

```sh
pragma-cli worktree list [--worktree <id>]
pragma-cli worktree create --branch <branch> [--parent <id>] [--title <title>]
pragma-cli worktree rename <id> <title>
pragma-cli worktree hide <id>
pragma-cli worktree unhide <id>
pragma-cli worktree delete <id> [--delete-branch] [--force]
```

`create` coordinates Git checkout, Pragma metadata, and setup scripts. `delete` refuses
dirty worktrees unless `--force` is explicit.

## Tabs

```sh
pragma-cli tab list [--worktree <id> | --all]
pragma-cli tab read <tab> [--lines <n>] [--offset <n>] [--bytes <n>] [--plain | --raw] [--watch]
pragma-cli tab open [--worktree <id>] --kind terminal --command "bun test" --title "Tests"
pragma-cli tab open [--worktree <id>] --kind browser --url https://example.com
pragma-cli tab close <tab>
pragma-cli tab rename <tab> <title>
pragma-cli tab exec [--worktree <id>] -- <command> [args...]
```

Tab kinds: `terminal`, `browser`, `editor`, `diff`, `log`, `pr-review`. `tab read` uses
bounded host scrollback. `--watch` prints current output then streams updates. `tab exec`
runs without opening a tab.

## Splits And Browser Tabs

```sh
pragma-cli split set --worktree <id> '<layout-json>'
pragma-cli split add-tab --worktree <id> --side right --kind terminal --command "bun test"
pragma-cli split clear --worktree <id>

pragma-cli browser navigate <tab> <url>
pragma-cli browser back <tab>
pragma-cli browser forward <tab>
pragma-cli browser reload <tab>
pragma-cli browser scroll <tab> --y 600
pragma-cli browser focus <tab> '<selector>'
pragma-cli browser click <tab> '<selector>'
pragma-cli browser screenshot <tab> [--out <file>]
pragma-cli browser exec <tab> '<javascript>'
pragma-cli browser close <tab>
```

Browser commands control Pragma browser-webview tabs, not arbitrary system browser.

## Agent Lifecycle

```sh
pragma-cli agent status [--worktree <id>] [--watch]
pragma-cli agent report --agent <id> started
pragma-cli agent report --agent <id> stopped
pragma-cli agent report --agent <id> attention
pragma-cli agent report --agent <id> session-name --name "Refactor auth"
pragma-cli agent report --agent <id> cleared
```

| Report         | Runtime state | Use                                               |
| -------------- | ------------- | ------------------------------------------------- |
| `started`      | `running`     | Turn or tool work began.                          |
| `stopped`      | `done`        | Started work finished with meaningful output.     |
| `attention`    | `attention`   | Agent needs input or permission.                  |
| `cleared`      | removed       | Process exited, aborted, reset, or has no result. |
| `session-name` | unchanged     | Rename hosting tab without changing status.       |

`stopped` should follow `started`. Use `cleared`, not `stopped`, for abort or process exit.

```sh
pragma-cli agent message --agent <id> --payload '<AgentMessage-json>'
pragma-cli agent message --agent <id> --stdin
```

## Questions And Approvals

```sh
pragma-cli agent report --agent <id> attention \
  --kind command --command "rm generated.tmp" --request-id <request-id>
pragma-cli agent await-decision --agent <id> --request-id <request-id> --timeout 300
pragma-cli agent decide --agent <id> --request-id <request-id> --allow

pragma-cli agent report --agent <id> attention \
  --kind question --question "Choose database" \
  --options '[{"label":"SQLite"},{"label":"Postgres"}]' \
  --request-id <request-id>
pragma-cli agent await-answer --agent <id> --request-id <request-id> --timeout 300
pragma-cli agent answer --agent <id> --request-id <request-id> --text "SQLite"
pragma-cli agent answer --agent <id> --request-id <request-id> --dismiss
```

Await commands print matching result and exit zero. Timeout exits non-zero with no output,
letting host hook fall back to native prompt. `await-answer` supports
`--dismiss-output <value>` when dismissal must differ from timeout.

```sh
pragma-cli agent input --agent <id> --text "Also update migration docs" [--request-id <id>]
```

## Verification

```sh
pragma-cli agent verify --agent <catalog-id>
pragma-cli agent verify --agent <catalog-id> --scenario <id> --jobs 1
pragma-cli agent verify --agent <catalog-id> --model <model-id>
pragma-cli agent verify --agent <catalog-id> --pick-model-cmd "--model provider/model"
```

Verification launches real sessions and can consume model tokens. Default is headless;
pass `--headed` only to test desktop launch brokering. Load `agent-plugin.md` for full rules.

## Scratchpads And Fanouts

```sh
pragma-cli scratchpad create --title "Architecture" result.mdx
pragma-cli scratchpad create --title "Architecture" -

pragma-cli fanout create "Implement token refresh" \
  --agent opencode --agent claude-code --reasoning high
pragma-cli fanout show [<id>] [--watch]
pragma-cli fanout read [<id>] --all --lines 100
pragma-cli fanout send [<id>] --all --message "Include migration docs"
pragma-cli fanout retry [<id>] --member <member-id>
pragma-cli fanout cancel [<id>]
pragma-cli fanout pick [<id>] --member <member-id>
```

Create scratchpads through CLI; do not write managed directory directly. Fanouts have no
`list`: omitted id resolves from environment/current worktree. `pick` merges winner and
deletes attempt worktrees and branches; automation needs explicit `--yes`.

A fanout selector is `agent[.model[.reasoning]]`, resolved as longest catalog agent
prefix, then remainder as **exact** model id, then final segment as reasoning effort — so
a dotted model id like `openai/gpt-5.6` is never mangled. Duplicate selectors are allowed;
sampling one model twice is supported. `--reasoning` sets a fanout-wide default any
selector can override; a default no selected model offers rejects create before anything
is provisioned. `--parent` picks the parent worktree, `--new-parent <branch>` creates a
coordination parent, and `--prompt-file <file>` reads the prompt (`-` reads stdin).

## Transport And Links

Desktop-only operations broker through connected app. Host-safe operations such as
terminal reading, reporting, and fanouts can talk directly to persistent host.

- Documentation: https://pragma-app.sh/docs
- Source: https://github.com/pragma-sh/pragma/tree/main/crates/pragma-cli
