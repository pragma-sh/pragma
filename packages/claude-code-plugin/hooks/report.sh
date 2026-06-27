#!/usr/bin/env sh
# Pragma <-> Claude Code status bridge.
#
# Invoked by hooks/hooks.json on Claude Code lifecycle events (see the hook ->
# status table in AGENTS.md). Each event is translated into a `pragma-cli`
# status report for the current Pragma terminal tab. Outside a Pragma terminal
# PRAGMA_DAEMON_SOCKET is unset and there is no daemon to talk to, so every
# event is a silent no-op (exit 0).
#
# Abort handling (the hard part): when a user cancels a turn -- ESC mid-response,
# rejecting a command's permission prompt, or declining a question -- Claude Code
# fires NO hook at all. We verified this against every hook event in 2.1.186:
# Stop does not fire, SessionEnd does not fire, and the idle-prompt Notification
# (which DOES fire ~60s after a normal completion) never fires after a cancel.
# So a hook-only bridge can never observe the cancel and the tab stays stuck on
# `running`/`attention` until the next prompt or quit.
#
# The cancel *is*, however, written to the session transcript immediately: the
# turn ends with a trailing `user` message whose text is
# "[Request interrupted by user]" (or "... for tool use"). Since no hook reports
# it, we watch for it instead: `started` spawns a detached background watcher
# that polls the transcript and, the moment the active turn's tail shows the
# interrupt marker, reports `cleared` and exits. Normal completion (`Stop`),
# session start/end, and the next turn all tear the watcher down, so it only
# lives while a turn could still be cancelled.

set -u

# Outside Pragma there is no server to report to; every event is a silent no-op.
[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="claude-code"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Per-tab files: the marker holds the active turn's token (presence = a turn is
# in flight); the pidfile holds the current watcher's pid so a new turn (or a
# normal end) can tear it down. Both are keyed on PRAGMA_TAB_ID.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
pidfile="${state_dir}/pragma-cli-${agent}-${tab}.watcher"

# Poll cadence and absolute lifetime backstop (overridable for tests). The
# backstop guarantees a watcher can't outlive its session forever if the session
# is killed uncatchably (SIGKILL) and the marker is never removed.
interval="${PRAGMA_WATCH_INTERVAL:-1}"
max_lifetime="${PRAGMA_WATCH_MAX:-86400}"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Claude Code session (e.g. when pragma-cli or the server is unavailable).
report() {
  pragma-cli --agent "$agent" report "$@" >/dev/null 2>&1 || true
}

# Reads the hook's stdin JSON and prints the `transcript_path` field, if any.
# Claude Code passes a JSON payload on stdin to every command hook.
transcript_path_from_stdin() {
  sed -n 's/.*"transcript_path":"\([^"]*\)".*/\1/p' | head -n 1
}

# Succeeds when the most recent turn in the transcript ended in a user
# interruption (cancel/abort). The marker is written as the final user message
# of the cancelled turn, so we only inspect the tail -- an interruption earlier
# in a turn that later continued must not count (later lines push it out).
turn_interrupted() {
  tp="$1"
  [ -n "$tp" ] && [ -f "$tp" ] || return 1
  tail -n 5 "$tp" 2>/dev/null | grep -q '\[Request interrupted by user'
}

# Like turn_interrupted, but scoped to transcript content written *after* `off`
# bytes -- i.e. only this turn's tail. This lets the watcher ignore an interrupt
# marker left by an earlier, already-cleared turn: that marker is the file's last
# line, so a plain tail would see it the instant a new turn starts -- before
# Claude has appended anything -- and false-clear a turn that is merely thinking.
interrupted_since() {
  tp="$1"
  off="${2:-0}"
  [ -n "$tp" ] && [ -f "$tp" ] || return 1
  [ -n "$off" ] || off=0
  tail -c "+$((off + 1))" "$tp" 2>/dev/null | grep -q '\[Request interrupted by user'
}

# Stops the current watcher (if any) and forgets its pid. Best-effort: the
# watcher also self-exits once the marker is gone, so a missed kill is harmless.
stop_watcher() {
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
    rm -f "$pidfile"
  fi
}

# Background watcher loop. Polls the transcript for the cancel marker that no
# hook reports. `token` pins it to the turn that spawned it: if the marker is
# removed (normal end / session end) or rewritten (a new turn started), the
# watcher exits without touching state, so it can never clobber a later turn.
run_watcher() {
  tp="$1"
  token="$2"
  offset="${3:-0}"
  deadline=$(($(date +%s) + max_lifetime))
  while :; do
    # Turn ended or was superseded -> nothing to clear, exit quietly.
    [ -f "$marker" ] || exit 0
    [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
    if interrupted_since "$tp" "$offset"; then
      # Re-check the token right before acting so we never clear a turn that
      # started in the gap between the poll and now.
      [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
      rm -f "$marker"
      report cleared
      exit 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || exit 0
    sleep "$interval"
  done
}

# The watcher re-enters this same script as a detached child via `__watch`.
if [ "${1:-}" = "__watch" ]; then
  run_watcher "$2" "$3" "${4:-}"
  exit 0
fi

case "${1:-}" in
  started)
    # A new turn is in flight. Tag the marker with a unique token, report
    # running, then replace any prior watcher with a fresh one bound to this
    # turn's transcript and token.
    token="$$-$(date +%s)"
    printf '%s' "$token" >"$marker"
    report started
    stop_watcher
    tp="$(transcript_path_from_stdin)"
    if [ -n "$tp" ]; then
      # Pin the watcher to where the transcript stands *now* so a prior turn's
      # interrupt marker (already in the file) can't be mistaken for this turn's
      # cancel while Claude is still thinking and has appended nothing yet.
      offset=$(wc -c <"$tp" 2>/dev/null | tr -d '[:space:]')
      [ -n "$offset" ] || offset=0
      nohup sh "$0" __watch "$tp" "$token" "$offset" >/dev/null 2>&1 &
      echo "$!" >"$pidfile"
    fi
    ;;
  stopped)
    # `Stop` fires only on normal completion (never on a cancel). Tear down the
    # watcher and clear the in-flight marker; report the green "done" dot. The
    # transcript check is a belt-and-suspenders for any build where Stop might
    # trail an interrupt.
    stop_watcher
    rm -f "$marker"
    if turn_interrupted "$(transcript_path_from_stdin)"; then
      report cleared
    else
      report stopped
    fi
    ;;
  cleared)
    stop_watcher
    rm -f "$marker"
    report cleared
    ;;
  running)
    # PostToolUse: a tool just finished mid-turn. If a turn is in flight, re-assert
    # `running` so a lingering `attention` -- left by an approved permission prompt,
    # which Claude Code reports via Notification but never *clears* with any hook --
    # drops back to "in progress" at once instead of staying stuck until `Stop`. We
    # deliberately leave the marker and the abort watcher untouched: this is the same
    # turn `started` set up, so its cancel detection must keep running. Guarded on the
    # marker so a stray PostToolUse outside a turn can't flash a phantom "running".
    [ -f "$marker" ] && report started
    ;;
  attention)
    # Only raise attention while a turn is actually in flight. The fast
    # `PermissionRequest`/`Elicitation` hooks always fire mid-turn, so the marker
    # is present then and the guard never suppresses a real prompt. It is
    # defense-in-depth against any late/stray attention landing on an
    # already-finished turn (which nothing would clear). It is also why we no
    # longer wire the *debounced* `Notification permission_prompt` (~3-5s late):
    # after an approval the marker is still present, so that stale notification
    # would re-raise a phantom attention over a turn that is already running.
    [ -f "$marker" ] && report attention
    ;;
  idle)
    # Idle-prompt notification. After a normal completion the marker is already
    # gone, so this is a no-op and the green "done" dot is preserved. (It does
    # not fire after a cancel -- the watcher handles those -- but if a future
    # Claude Code build emits it, a lingering marker still clears the turn.)
    if [ -f "$marker" ]; then
      stop_watcher
      rm -f "$marker"
      report cleared
    fi
    ;;
esac

exit 0
