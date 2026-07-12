#!/usr/bin/env sh
# Pragma <-> Cursor Agent CLI status bridge.
#
# Invoked from ~/.cursor/hooks.json on Cursor lifecycle events (see AGENTS.md).
# Outside a Pragma terminal PRAGMA_DAEMON_SOCKET is unset and every event is a
# silent no-op (exit 0).
#
# Interactive questions are intentionally NOT reported as `attention --kind
# question`. Cursor's AskQuestion tool has no hook (no Claude-style
# PermissionRequest/Elicitation equivalent) and, while a question is pending,
# Cursor writes nothing to the session transcript or any other file -- the only
# live signal is the PTY terminal title, which a hook subprocess cannot see. So
# there is no plugin-level signal to bridge. Command/MCP approvals
# (beforeShellExecution / beforeMCPExecution) DO fire and are reported. See
# AGENTS.md ("AskQuestion") for the full rationale.

set -u

# Outside Pragma there is no server to report to; every event is a silent no-op.
[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="cursor"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Presence of the marker = a turn is in flight (keyed per Pragma tab). It gates
# the attention/running reports so a stray event outside a turn can't flash a
# phantom status onto an already-finished turn.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
# How long beforeShellExecution/beforeMCPExecution blocks waiting for a remote
# approve/deny from a Pragma toast before letting Cursor use its own prompt.
approval_timeout="${PRAGMA_APPROVAL_TIMEOUT:-300}"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Cursor session (e.g. when pragma-cli or the server is unavailable).
report() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

# Extracts the command awaiting approval from a beforeShellExecution /
# beforeMCPExecution stdin JSON payload ($1). Prefers jq for `.command`
# (shell) / `.tool_name` (MCP); falls back to a sed scrape so the approval toast
# always shows something even without jq.
extract_command() {
  input="$1"
  if command -v jq >/dev/null 2>&1; then
    cmd=$(printf '%s' "$input" | jq -r '.command // .tool_name // empty' 2>/dev/null)
    if [ -n "$cmd" ]; then
      printf '%s' "$cmd"
      return 0
    fi
  fi
  printf '%s' "$input" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p' | head -n 1
}

# AgentMessage.ts is milliseconds since Unix epoch (see @pragma/constants).
# `date +%s` is seconds — multiply so chat clients that stamp local input with
# Date.now() don't sort every agent bubble above the user's messages.
message_ts_ms() {
  echo $(($(date +%s) * 1000))
}

# Reports a coarse rich message without depending on jq or hook-specific JSON.
message() {
  role="$1"
  text="$2"
  id="${agent}-${tab}-$(date +%s)-$$-$role"
  ts="$(message_ts_ms)"
  payload='{"id":"'"$id"'","role":"'"$role"'","text":"'"$text"'","subAgentsActive":0,"ts":'"$ts"'}'
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

# Content-bearing hook fields need real JSON parsing and escaping. Python 3 is
# available on supported macOS/Linux hosts; without it, status reporting still
# works and coarse fallback messages preserve prior behavior.
py3="$(command -v python3 2>/dev/null || true)"

json_field() {
  [ -n "$py3" ] || return 0
  printf '%s' "$2" | "$py3" -c '
import json, sys
try:
    value = (json.load(sys.stdin) or {}).get(sys.argv[1])
except Exception:
    value = None
if isinstance(value, str):
    print(value)
' "$1" 2>/dev/null
}

content_message() {
  role="$1"
  text="$2"
  [ -n "$py3" ] && [ -n "$text" ] || return 0
  id="${agent}-${tab}-$(date +%s)-$$-$role"
  ts="$(message_ts_ms)"
  payload=$("$py3" -c '
import json, sys
print(json.dumps({
    "id": sys.argv[1],
    "role": sys.argv[2],
    "text": sys.argv[3],
    "subAgentsActive": 0,
    "ts": int(sys.argv[4]),
}))' "$id" "$role" "$text" "$ts" 2>/dev/null)
  [ -n "$payload" ] || return 0
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

case "${1:-}" in
  started)
    # A new turn is in flight: tag the marker and report running.
    printf '%s' "$$-$(date +%s)" >"$marker"
    report started
    input="$(cat)"
    prompt="$(json_field prompt "$input")"
    if [ -n "$prompt" ]; then
      content_message user "$prompt"
    else
      message assistant "Cursor Agent turn started"
    fi
    ;;
  stopped)
    rm -f "$marker"
    input="$(cat)"
    status="$(json_field status "$input")"
    case "$status" in
      aborted|error) report cleared ;;
      *) report stopped ;;
    esac
    ;;
  cleared)
    rm -f "$marker"
    report cleared
    ;;
  response)
    input="$(cat)"
    text="$(json_field text "$input")"
    if [ -n "$text" ]; then
      content_message assistant "$text"
    fi
    ;;
  running)
    # PostToolUse: a tool finished mid-turn. Re-assert running so a lingering
    # command-approval `attention` drops back to "in progress" at once instead
    # of staying stuck until `stop`. Guarded on the marker so a stray
    # PostToolUse outside a turn can't flash a phantom "running".
    if [ -f "$marker" ]; then
      report started
      message tool "Cursor Agent tool finished"
    fi
    ;;
  attention-command)
    # beforeShellExecution / beforeMCPExecution: a command/MCP call is awaiting
    # approval and Cursor is BLOCKED on this hook's stdout. Report a `command`
    # attention with the command text + a requestId, then block on
    # `await-decision` for the verdict a Pragma approval toast publishes. Emit
    # Cursor's `{"permission":...}` decision so approve runs the command and deny
    # rejects it, no terminal needed. On timeout emit nothing so Cursor falls
    # back to its own prompt. Only while a turn is actually in flight.
    if [ -f "$marker" ]; then
      input="$(cat)"
      command_text="$(extract_command "$input")"
      request_id="${agent}-${tab}-$(date +%s)-$$"
      report attention --kind command --command "$command_text" --request-id "$request_id"
      message tool "Cursor Agent command needs approval"
      verdict="$("$pragma_cli" agent await-decision \
        --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" 2>/dev/null)"
      case "$verdict" in
        allow) printf '%s\n' '{"permission":"allow"}' ;;
        deny) printf '%s\n' '{"permission":"deny"}' ;;
        *) : ;; # Timed out / no decision: defer to Cursor's own prompt.
      esac
    fi
    ;;
esac

exit 0
