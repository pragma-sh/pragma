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

# Outside Pragma there is no daemon to report to; every event is a silent no-op.
[ -n "${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="cursor"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Presence of the marker = a turn is in flight (keyed per Pragma tab). It gates
# the attention/running reports so a stray event outside a turn can't flash a
# phantom status onto an already-finished turn.
marker="${state_dir}/pragma-agent-${agent}-${tab}.active"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Cursor session (e.g. when pragma-agent or the daemon is unavailable).
report() {
  pragma-agent --agent "$agent" report "$@" >/dev/null 2>&1 || true
}

case "${1:-}" in
  started)
    # A new turn is in flight: tag the marker and report running.
    printf '%s' "$$-$(date +%s)" >"$marker"
    report started
    ;;
  stopped)
    rm -f "$marker"
    report stopped
    ;;
  cleared)
    rm -f "$marker"
    report cleared
    ;;
  running)
    # PostToolUse: a tool finished mid-turn. Re-assert running so a lingering
    # command-approval `attention` drops back to "in progress" at once instead
    # of staying stuck until `stop`. Guarded on the marker so a stray
    # PostToolUse outside a turn can't flash a phantom "running".
    [ -f "$marker" ] && report started
    ;;
  attention-command)
    # beforeShellExecution / beforeMCPExecution: a command/MCP call is awaiting
    # approval. Only raise attention while a turn is actually in flight.
    [ -f "$marker" ] && report attention --kind command
    ;;
esac

exit 0
