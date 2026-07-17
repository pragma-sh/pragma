# crates/pragma-cli - pragma-cli

CLI for Pragma host/client utilities and external agent status reporting. The
binary name is `pragma-cli` (not bare `pragma`, which collides with the app
crate's debug binary).

## Current Usage

```sh
pragma-cli agent report --agent <id> started|stopped|attention|cleared
# Command approval: report the command + a correlation id, then block for the verdict.
pragma-cli agent report --agent <id> attention --kind command --command "<cmd>" --request-id <id>
pragma-cli agent await-decision --agent <id> --request-id <id> [--timeout 300]
pragma-cli agent decide --agent <id> --request-id <id> --allow|--deny
# Question/answer: report the question (+ optional JSON answer choices) + a
# correlation id, then block for the reply.
pragma-cli agent report --agent <id> attention --kind question --question "<q>" \
  --options '[{"label":"Yes","description":"..."},{"label":"No"}]' --request-id <id>
pragma-cli agent await-answer --agent <id> --request-id <id> [--timeout 300]
pragma-cli agent answer --agent <id> --request-id <id> --text "<reply>"|--dismiss
# Interject: publish free-form input to a running agent (the controlling-client side).
pragma-cli agent input --agent <id> --text "<message>" [--request-id <id>]
# End-to-end integration verification through the gateway/mobile API surface.
pragma-cli agent verify --agent <id> [--scenario <id>] [--abort-input '\x1b']
```

`agent await-decision` blocks on the agent event stream until a Pragma approval toast
publishes the matching `AgentDecision`, then prints `allow`/`deny` (exit 0). On timeout it
prints nothing and exits non-zero so a blocking harness hook (Claude Code
`PermissionRequest`, Cursor `beforeShellExecution`) can fall back to its native prompt.
`agent decide` is the controlling-client side: it publishes that verdict.

`agent await-answer` mirrors this for questions: it blocks until the matching `AgentAnswer`
arrives, then prints the reply text (exit 0). A dismissed reply or timeout prints nothing
and exits non-zero so the caller can fall back. Hooks that must distinguish dismissal from
timeout can pass `--dismiss-output <value>`; dismissal then prints that value and exits 0.
`agent answer` publishes the reply (`--text`) or a dismissal (`--dismiss`).

`agent input` publishes an `AgentInput` (a free-form interjection) fanned out to agent
subscribers; the waiting reporter — a harness input hook or a plugin watcher — delivers the
text into the running agent's turn. It is fire-and-forget (no verdict to wait for) and is the
CLI side of the SDK's `client.agents.connect(...).send(text)`.

`agent verify` discovers the local gateway, launches fresh real-agent sessions from the
plugin catalog, drives question/decision/abort scenarios over HTTP, and strictly parses
the same NDJSON event stream mobile consumes. Events are scoped by the RUNTIME agent id
(final segment of the catalog id), exactly like mobile's stream filter — a plugin
reporting under the qualified catalog id fails verification because those consumers
would never see it. It runs all scenarios by default, retries
LLM-dependent behavior with fresh sessions, and exits non-zero on any failure. Question
scenarios validate exact prompt/options, listed and custom answers, dismissal, and wrong
request-id isolation rather than accepting any generic question attention.
`question-free-text` requires an assistant message echoing the exact marker and accepts
two delivery paths: in-turn (a TUI custom-answer editor) or the watcher-kit
`questionFreeTextMode: "interject"` secondary path, where the watcher selects the TUI's
fallback row (Codex's "None of the above"), aborts the response, and resubmits the
answer as an `Answer to question ...` follow-up prompt whose turn carries the marker.

`pragma-cli agent start` is brokered through the app but is not supported for
plugin-defined agents; launch agents from the Pragma UI so the frontend can run JS
plugin model/argument builders.

Every command renders plain text (aligned tables / short human lines) by
default. Two mutually exclusive global flags switch to structured output for
scripting:

- `--json` — `serde_json`-serialized output.
- `--toon` — [TOON](https://toonformat.dev) (Token-Oriented Object Notation)
  output via the `toon-format` crate, a token-efficient JSON alternative
  meant for LLM contexts (e.g. piping `pragma-cli tab list --all --toon`
  into an agent prompt instead of `--json`).

Both go through `crate::output::Output`, which serializes the same
`serde_json::Value`/`Serialize` payload either as JSON or, for `--toon`, by
converting it to a `serde_json::Value` and encoding that with
`toon_format::encode_default`.

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
