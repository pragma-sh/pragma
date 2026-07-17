# Agent CLI Reference

All commands use injected `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, and
`PRAGMA_SERVER_SOCKET` (legacy fallback: `PRAGMA_DAEMON_SOCKET`). Global `--json` and
`--toon` select structured output.

## Reports

```sh
pragma-cli agent report --agent <id> started
pragma-cli agent report --agent <id> stopped [--worktree-id <id>]
pragma-cli agent report --agent <id> attention \
  [--kind question|command] [--command <text>] [--question <text>] \
  [--options '<json-array>'] [--request-id <id>]
pragma-cli agent report --agent <id> cleared [--worktree-id <id>]
```

`--options` is a JSON array of `{ "label": string, "description"?: string }`.
Use `command` only with command attention and `question`/`options` only with question
attention.

## Rich Messages

```sh
pragma-cli agent message --agent <id> --payload '<AgentMessage-json>'
pragma-cli agent message --agent <id> --stdin
```

Routing fields are filled from environment and `--agent`. Payload must include stable
`id`, `role`, `subAgentsActive`, and `ts`; optional fields are `text`, `toolCalls`, and
`files`. `ts` is milliseconds since Unix epoch. POSIX `date +%s` returns seconds, so
multiply by 1000.

## Decisions

```sh
pragma-cli agent await-decision --agent <id> --request-id <id> [--timeout 300]
pragma-cli agent decide --agent <id> --request-id <id> --allow|--deny
```

Await prints `allow` or `deny` and exits 0. Timeout prints nothing and exits non-zero.
`0` waits indefinitely; avoid it in hooks.

## Questions

```sh
pragma-cli agent await-answer --agent <id> --request-id <id> \
  [--timeout 300] [--dismiss-output <marker>]
pragma-cli agent answer --agent <id> --request-id <id> --text <reply>
pragma-cli agent answer --agent <id> --request-id <id> --dismiss
```

Answered request prints text and exits 0. Default dismissal and timeout print nothing and
exit non-zero. With `--dismiss-output`, dismissal prints marker and exits 0.

## Interjection

```sh
pragma-cli agent input --agent <id> --text <message> [--request-id <id>]
```

Publishes free-form `AgentInput`; watcher or host input hook delivers it to TUI.

## Verification

```sh
pragma-cli agent verify --agent <catalog-id> [options]
```

Options:

- `--abort-input <escapes>`: PTY abort bytes; default `\x1b`. Supports `\e`, `\xNN`,
  `\r`, `\n`, `\t`, and `\\`.
- `--worktree <id>`: defaults to `PRAGMA_WORKTREE_ID`.
- `--model <id>`: defaults to first catalog model.
- `--pick-model-cmd <args>`: raw model command appended to the agent's base launch
  command instead of a catalog model (for example `--pick-model-cmd "--model moonshot/kimi-k3"`).
  Overrides `--model`. Use it to verify with the cheapest subagent-capable model the
  catalog does not list, to save tokens.
- `--scenario <id>`: repeatable scenario filter.
- `--attempts <n>`: fresh-session attempts for nondeterministic behavior; default 2.
- `--step-timeout <seconds>`: per-step budget; default 120.
- `--fail-fast`: stop after first failed scenario.
- `--include-slow`: include decision-timeout scenario.
- `--prompts <file.json>`: object mapping scenario ids to prompt overrides.

Exit is non-zero when any scenario fails. Skips do not fail. Plain output is a table;
global `--json` and `--toon` serialize same report.
