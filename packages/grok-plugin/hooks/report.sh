#!/usr/bin/env sh
# Pragma <-> Grok Build status bridge.
#
# Invoked by hooks/hooks.json on Grok lifecycle events (see the hook -> status
# table in AGENTS.md). Each event becomes a `pragma-cli` status report for the
# current Pragma terminal tab. Outside a Pragma terminal PRAGMA_SERVER_SOCKET /
# PRAGMA_DAEMON_SOCKET are unset and there is no server to talk to, so every
# event is a silent no-op (exit 0).
#
# Grok's stdin envelope is camelCase throughout (`sessionId`, `hookEventName`,
# `toolName`, `lastAssistantMessage`, ...) where Claude Code uses snake_case.
# Grok also hands every event a `transcriptPath` pointing straight at the
# session's `updates.jsonl`, so nothing here has to reconstruct the URL-encoded
# session directory.
#
# Abort handling (the hard part): an interrupted turn (Esc / Ctrl+C) skips Stop
# hooks *entirely* -- grok only runs the gate for genuine completions. So a
# hook-only bridge can never see a cancel and the tab would stay stuck on
# `running` until the next prompt. The cancel *is* recorded immediately in two
# places next to the transcript, and `started` spawns one detached per-tab
# watcher that polls both:
#   * `signals.json`.cancellationCount -- a monotonic counter; the watcher
#     captures its value at turn start and clears the moment it grows.
#   * `updates.jsonl` -- a `turn_completed` record whose `stop_reason` is
#     anything other than `end_turn`, scanned only past this turn's starting
#     byte offset so an earlier turn's record can never clear a new turn.
# The same watcher streams assistant output mid-turn (see sync_messages).

set -u

# Outside Pragma there is no server to report to; every event is a silent no-op.
[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="grok"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Per-tab files: the marker holds the active turn's token (presence = a turn is
# in flight); the pidfile holds the current watcher's pid so a new turn (or a
# normal end) can tear it down.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
pidfile="${state_dir}/pragma-cli-${agent}-${tab}.watcher"
session_file="${state_dir}/pragma-cli-${agent}-${tab}.session"
# Last session name reported for this tab, so a rename is sent once per change.
named_file="${state_dir}/pragma-cli-${agent}-${tab}.sessionname"
children_dir="${state_dir}/pragma-cli-${agent}-${tab}.subagents"
# The session id that owns the in-flight marker, so a late `cleared` from a
# superseded session cannot wipe a turn that already started in a new one.
turn_session_file="${state_dir}/pragma-cli-${agent}-${tab}.turn-session"
# Characters of assistant output already streamed for the active turn.
sent_file="${state_dir}/pragma-cli-${agent}-${tab}.sent"
# Transcript byte offset the active turn started at, so `stopped` can run the
# final message sync over the same window the watcher used.
offset_file="${state_dir}/pragma-cli-${agent}-${tab}.offset"

# Poll cadence and absolute lifetime backstop (overridable for tests). The
# backstop guarantees a watcher can't outlive its session forever if the session
# is killed uncatchably (SIGKILL) and the marker is never removed.
interval="${PRAGMA_WATCH_INTERVAL:-1}"
max_lifetime="${PRAGMA_WATCH_MAX:-86400}"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Grok session (e.g. when pragma-cli or the server is unavailable).
report() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

# AgentMessage.ts is milliseconds since Unix epoch (see @pragma/constants).
# `date +%s` is seconds -- multiply so chat clients that stamp local input with
# Date.now() don't sort every agent bubble above the user's messages.
message_ts_ms() {
  echo $(($(date +%s) * 1000))
}

# Reports a coarse status-only message with no user/agent content in it, so it
# needs no JSON escaping and works without python3.
message() {
  role="$1"
  text="$2"
  id="${agent}-${tab}-$(date +%s)-$$-$role"
  ts="$(message_ts_ms)"
  active="$(tracked_subagent_count)"
  payload='{"id":"'"$id"'","role":"'"$role"'","text":"'"$text"'","subAgentsActive":'"$active"',"ts":'"$ts"'}'
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

# Content-bearing messages (the user's prompt, the assistant's reply) need real
# JSON parsing/escaping that POSIX sh cannot do safely; python3 ships with macOS
# and every mainstream Linux distro, and the sibling hook bridges
# (claude-code-plugin, codex-plugin, cursor-plugin) already depend on it the same
# way. When it's missing these helpers do nothing and the bridge degrades to the
# coarse status-only messages above.
#
# Windows is the exception, and being on PATH is not proof of being usable there:
# it ships an App Execution Alias at
# ~/AppData/Local/Microsoft/WindowsApps/python3 that only prints "Python was not
# found" and exits nonzero. That satisfies `command -v`, so the emptiness checks
# below would wrongly take the has-python branch. Run it once and drop it unless
# it actually executes.
py3="$(command -v python3 2>/dev/null || true)"
if [ -n "$py3" ] && ! "$py3" -c '' >/dev/null 2>&1; then
  py3=""
fi

# Prints a top-level string field from the JSON document passed as $2.
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

# Prints the transcript path (grok points it at the session `updates.jsonl`).
# Prefer real JSON parsing; retain a portable fallback for hosts without python3.
transcript_path() {
  input="$1"
  value="$(json_field transcriptPath "$input")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$input" | sed -n 's/.*"transcriptPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Grok wraps every submitted prompt in a `<user_query>` envelope before it
# reaches hooks. Strip it so chat bubbles and derived session names show what
# the user actually typed.
unwrap_prompt() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import re, sys
text = sys.stdin.read()
match = re.search(r"<user_query>\n?(.*?)\n?</user_query>", text, re.DOTALL)
sys.stdout.write((match.group(1) if match else text).strip())
' 2>/dev/null
}

# Prints a tab-title-sized name from arbitrary text (first nonblank line).
# Silent no-op without python3 (the session simply stays unnamed).
session_name_from_text() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import sys
line = ""
for candidate in sys.stdin.read().splitlines():
    if candidate.strip():
        line = candidate.strip()
        break
print(line if len(line) <= 48 else line[:47].rstrip() + "…")
' 2>/dev/null
}

# Prints grok's own generated session title from `summary.json`, which sits next
# to the transcript. It only exists once grok has summarized the session, so
# callers fall back to the prompt for the very first turn.
session_title() {
  tp="$1"
  [ -n "$py3" ] && [ -n "$tp" ] || return 0
  summary="$(dirname "$tp")/summary.json"
  [ -f "$summary" ] || return 0
  "$py3" -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8")) or {}
except Exception:
    sys.exit(0)
for key in ("generated_title", "session_summary"):
    value = data.get(key)
    if isinstance(value, str) and value.strip():
        print(value.strip())
        break
' "$summary" 2>/dev/null
}

# Names the hosting tab after grok's generated session title, falling back to
# the first prompt until grok has produced one. Reported only when it changes,
# so a rename lands once per title. Pragma preserves manual tab renames.
report_session_name() {
  tp="$1"
  fallback="$2"
  session_name="$(session_title "$tp")"
  [ -n "$session_name" ] || session_name="$(session_name_from_text "$fallback")"
  [ -n "$session_name" ] || return 0
  [ "$(cat "$named_file" 2>/dev/null)" = "$session_name" ] && return 0
  report session-name --name "$session_name"
  printf '%s' "$session_name" >"$named_file"
}

# Reports a rich message whose text is JSON-escaped (safe for arbitrary
# content). Silent no-op without python3 or when the text is empty.
content_message() {
  role="$1"
  text="$2"
  id="${3:-${agent}-${tab}-$(date +%s)-$$-$role}"
  [ -n "$py3" ] && [ -n "$text" ] || return 0
  ts="$(message_ts_ms)"
  active="$(tracked_subagent_count)"
  payload=$("$py3" -c '
import json, sys
print(json.dumps({
    "id": sys.argv[1],
    "role": sys.argv[2],
    "text": sys.argv[3],
    "subAgentsActive": int(sys.argv[5]),
    "ts": int(sys.argv[4]),
}))' "$id" "$role" "$text" "$ts" "$active" 2>/dev/null)
  [ -n "$payload" ] || return 0
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

# Succeeds when a Stop payload reports at least one subagent still running in
# `backgroundTasks`. Such a Stop only ends the parent's *inference turn* -- the
# session keeps working and grok auto-resumes when the child finishes -- so
# reporting `stopped` would flip the tab to done while agents are still active.
has_running_subagents() {
  [ -n "$py3" ] || return 1
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    tasks = (json.load(sys.stdin) or {}).get("backgroundTasks") or []
except Exception:
    tasks = []
running = any(
    isinstance(t, dict) and t.get("type") == "subagent" and t.get("status") != "completed"
    for t in tasks
)
sys.exit(0 if running else 1)
' 2>/dev/null
}

# Grok's SubagentStart/SubagentStop hooks provide durable accounting when several
# children overlap. Stop.backgroundTasks is retained as a fallback.
child_marker() {
  child_id="$1"
  child_key=$(printf '%s' "$child_id" | cksum | tr -d '[:space:]')
  printf '%s/%s' "$children_dir" "$child_key"
}

track_subagent() {
  child_id="$1"
  [ -n "$child_id" ] || return 0
  mkdir -p "$children_dir"
  : >"$(child_marker "$child_id")"
}

untrack_subagent() {
  child_id="$1"
  [ -n "$child_id" ] || return 0
  rm -f "$(child_marker "$child_id")"
  rmdir "$children_dir" 2>/dev/null || true
}

has_tracked_subagents() {
  [ -d "$children_dir" ] || return 1
  for child in "$children_dir"/*; do
    [ -f "$child" ] && return 0
  done
  return 1
}

tracked_subagent_count() {
  count=0
  if [ -d "$children_dir" ]; then
    for child in "$children_dir"/*; do
      [ -f "$child" ] && count=$((count + 1))
    done
  fi
  printf '%s' "$count"
}

clear_subagents() {
  if [ -d "$children_dir" ]; then
    rm -f "$children_dir"/*
    rmdir "$children_dir" 2>/dev/null || true
  fi
}

# Prints a human-readable summary of a tool call from a PreToolUse payload.
tool_summary() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    payload = json.load(sys.stdin) or {}
except Exception:
    sys.exit(0)
name = payload.get("toolName") or "tool"
tool_input = payload.get("toolInput")
if not isinstance(tool_input, dict):
    tool_input = {}
command = tool_input.get("command")
if isinstance(command, str) and command:
    print(command)
    sys.exit(0)
path = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("target_file")
print(f"{name} {path}" if isinstance(path, str) and path else name)
' 2>/dev/null
}

# Prints the question text of an `ask_user_question` PreToolUse payload when it
# carries exactly one question. Grok's TUI owns the answer UI (there is no
# decision-returning hook for it), so this is used for the attention label only.
question_text() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    tool_input = (json.load(sys.stdin) or {}).get("toolInput") or {}
except Exception:
    sys.exit(0)
if not isinstance(tool_input, dict):
    sys.exit(0)
questions = tool_input.get("questions")
if isinstance(questions, list) and len(questions) == 1 and isinstance(questions[0], dict):
    tool_input = questions[0]
for key in ("question", "prompt", "text", "title"):
    value = tool_input.get(key)
    if isinstance(value, str) and value.strip():
        print(value.strip())
        break
' 2>/dev/null
}

# Prints grok's cancellation counter for a session. `signals.json` sits next to
# the transcript and is rewritten on every turn; the counter only ever grows, so
# comparing it against the value captured at turn start detects an interrupt
# without parsing the transcript at all.
cancellations() {
  tp="$1"
  signals="$(dirname "$tp")/signals.json"
  [ -f "$signals" ] || return 0
  sed -n 's/.*"cancellationCount"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$signals" |
    head -n 1
}

# Succeeds when the transcript recorded a non-`end_turn` turn end after `off`
# bytes -- i.e. this turn was interrupted, refused, or hit its turn cap. Scoped
# to this turn's tail so an earlier turn's record cannot clear a new turn.
aborted_since() {
  tp="$1"
  off="${2:-0}"
  [ -n "$tp" ] && [ -f "$tp" ] || return 1
  [ -n "$off" ] || off=0
  tail -c "+$((off + 1))" "$tp" 2>/dev/null |
    grep -o '"sessionUpdate":"turn_completed","prompt_id":"[^"]*","stop_reason":"[^"]*"' |
    grep -qv '"stop_reason":"end_turn"'
}

# Streams the assistant text produced so far in this turn. Grok records one
# `agent_message_chunk` per streamed delta, so the chunks are concatenated into
# a single growing message reported under one stable per-turn id -- chat
# consumers (mobile) update that bubble in place instead of receiving a wall of
# fragments, and the reply is visible while the turn is still running rather
# than only after `Stop`. A state file holds the character count already sent so
# repeated polls (and the final sync `stopped` performs) are idempotent.
assistant_text_since() {
  tp="$1"
  off="${2:-0}"
  [ -n "$py3" ] && [ -n "$tp" ] && [ -f "$tp" ] || return 0
  "$py3" -c '
import json, sys
path, offset = sys.argv[1], int(sys.argv[2])
parts = []
try:
    with open(path, "rb") as handle:
        handle.seek(offset)
        for raw in handle:
            try:
                record = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                continue
            update = ((record.get("params") or {}).get("update") or {})
            if update.get("sessionUpdate") != "agent_message_chunk":
                continue
            content = update.get("content") or {}
            text = content.get("text")
            if isinstance(text, str):
                parts.append(text)
except Exception:
    sys.exit(0)
sys.stdout.write("".join(parts))
' "$tp" "$off" 2>/dev/null
}

# Emits the turn's assistant text under the stable id `grok-<token>-assistant`
# whenever it has grown since the last sync.
sync_messages() {
  tp="$1"
  off="$2"
  token="$3"
  [ -n "$py3" ] || return 0
  text="$(assistant_text_since "$tp" "$off")"
  [ -n "$text" ] || return 0
  sent="$(cat "$sent_file" 2>/dev/null)"
  [ -n "$sent" ] || sent=0
  length=${#text}
  [ "$length" -gt "$sent" ] || return 0
  content_message assistant "$text" "${agent}-${token}-assistant"
  printf '%s' "$length" >"$sent_file"
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

# Background watcher loop. Streams assistant output and polls for the cancel
# that no hook reports. `token` pins it to the turn that spawned it: if the
# marker is removed (normal end / session end) or rewritten (a new turn
# started), the watcher exits without touching state, so it can never clobber a
# later turn.
run_watcher() {
  tp="$1"
  token="$2"
  offset="${3:-0}"
  baseline="${4:-0}"
  deadline=$(($(date +%s) + max_lifetime))
  while :; do
    # Turn ended or was superseded -> nothing to clear, exit quietly.
    [ -f "$marker" ] || exit 0
    [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
    sync_messages "$tp" "$offset" "$token"
    current="$(cancellations "$tp")"
    [ -n "$current" ] || current="$baseline"
    if [ "$current" -gt "$baseline" ] 2>/dev/null || aborted_since "$tp" "$offset"; then
      # Re-check the token right before acting so we never clear a turn that
      # started in the gap between the poll and now.
      [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
      rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file"
      report cleared
      exit 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || exit 0
    sleep "$interval"
  done
}

# The watcher re-enters this same script as a detached child via `__watch`.
if [ "${1:-}" = "__watch" ]; then
  run_watcher "$2" "$3" "${4:-}" "${5:-0}"
  exit 0
fi

input="$(cat)"
hook_event_name="$(json_field hookEventName "$input")"
hook_session_id="$(json_field sessionId "$input")"
if [ -z "$hook_session_id" ]; then
  hook_session_id="${GROK_SESSION_ID:-}"
fi

# Subagent lifecycle first: those hooks share the parent terminal environment,
# so they are accounted for explicitly and never fall through to the parent
# status machine below.
if [ "${1:-}" = "subagent-start" ]; then
  child_id="$(json_field agentId "$input")"
  [ -n "$child_id" ] || child_id="$(json_field subagentId "$input")"
  [ -n "$child_id" ] || child_id="$(json_field agentType "$input")-$hook_session_id"
  track_subagent "$child_id"
  [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
  message system "Grok started a subagent"
  report started
  exit 0
fi
if [ "${1:-}" = "subagent-stop" ]; then
  child_id="$(json_field agentId "$input")"
  [ -n "$child_id" ] || child_id="$(json_field subagentId "$input")"
  [ -n "$child_id" ] || child_id="$(json_field agentType "$input")-$hook_session_id"
  untrack_subagent "$child_id"
  exit 0
fi

# Pin this tab to the parent session established by SessionStart /
# UserPromptSubmit and reject every event from a different session before it can
# alter parent status. A subagent runs with its own session id, so its
# PreToolUse / PostToolUse events are dropped here.
case "$hook_event_name" in
  session_start | user_prompt_submit)
    [ -z "$hook_session_id" ] || printf '%s' "$hook_session_id" >"$session_file"
    ;;
esac
if [ -n "$hook_session_id" ] && [ -f "$session_file" ]; then
  parent_session_id="$(cat "$session_file" 2>/dev/null)"
  [ -z "$parent_session_id" ] || [ "$hook_session_id" = "$parent_session_id" ] || exit 0
fi

case "${1:-}" in
  started)
    # A new turn is in flight. Tag the marker with a unique token, report
    # running, then replace any prior watcher with a fresh one bound to this
    # turn's transcript, byte offset and cancellation baseline.
    token="$$-$(date +%s)"
    printf '%s' "$token" >"$marker"
    printf '%s' "$hook_session_id" >"$turn_session_file"
    rm -f "$sent_file" "$offset_file"
    report started
    tp="$(transcript_path "$input")"
    prompt="$(unwrap_prompt "$(json_field prompt "$input")")"
    if [ -n "$prompt" ]; then
      content_message user "$prompt"
    else
      message assistant "Grok turn started"
    fi
    report_session_name "$tp" "$prompt"
    stop_watcher
    if [ -n "$tp" ]; then
      # Pin the watcher to where the transcript stands *now* so a prior turn's
      # records can't be mistaken for this turn's output or cancel.
      offset=$(wc -c <"$tp" 2>/dev/null | tr -d '[:space:]')
      [ -n "$offset" ] || offset=0
      printf '%s' "$offset" >"$offset_file"
      baseline="$(cancellations "$tp")"
      [ -n "$baseline" ] || baseline=0
      nohup sh "$0" __watch "$tp" "$token" "$offset" "$baseline" >/dev/null 2>&1 &
      echo "$!" >"$pidfile"
    fi
    ;;
  stopped)
    # Grok fires Stop only for genuine completions, plus one extra observe-only
    # Stop at session end (`reason` = shutdown / channel_closed). SessionEnd has
    # already cleared the tab by then, so anything but `end_turn` is ignored.
    reason="$(json_field reason "$input")"
    if [ -n "$reason" ] && [ "$reason" != "end_turn" ]; then
      exit 0
    fi
    tp="$(transcript_path "$input")"
    if has_running_subagents "$input" || has_tracked_subagents; then
      # The parent's inference turn ended, but subagents are still working and
      # grok resumes the parent when they finish -- the session is NOT done.
      # Stay on `started` and keep the marker and watcher alive so a cancel
      # during the subagent phase is still detected.
      [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
      report started
      message assistant "Grok is waiting on subagents"
      exit 0
    fi
    if [ ! -f "$marker" ]; then
      # No turn was ever started for this tab: a bare Stop must not create a
      # phantom done dot.
      exit 0
    fi
    token="$(cat "$marker" 2>/dev/null)"
    stop_watcher
    # Final reply before `stopped`, so the reply event always precedes the done
    # report for chat consumers.
    #
    # Neither source is complete on its own. The transcript holds every chunk of
    # the turn, but grok fires Stop before flushing the last one -- reading it
    # alone drops the closing text. `lastAssistantMessage` holds exactly that
    # closing text, but only it: grok emits one assistant message per tool round,
    # so using it alone would replace a whole turn's reply with its final
    # sentence. Concatenate, unless the transcript already caught up.
    offset="$(cat "$offset_file" 2>/dev/null)"
    [ -n "$offset" ] || offset=0
    synced=""
    [ -z "$tp" ] || synced="$(assistant_text_since "$tp" "$offset")"
    reply="$(json_field lastAssistantMessage "$input")"
    final="$synced"
    if [ -n "$reply" ]; then
      case "$synced" in
        *"$reply") ;;
        *) final="${synced}${reply}" ;;
      esac
    fi
    [ -z "$final" ] || content_message assistant "$final" "${agent}-${token}-assistant"
    rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file"
    report stopped
    report_session_name "$tp" ""
    ;;
  failed)
    # StopFailure: the turn ended on an API error, so it never completed. Clear
    # rather than report done.
    if [ -f "$marker" ]; then
      stop_watcher
      rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file"
      report cleared
      detail="$(json_field error "$input")"
      [ -n "$detail" ] || detail="unknown error"
      message system "Grok turn failed ($detail)"
    fi
    ;;
  cleared)
    # SessionStart fires for a brand new session while the previous one's
    # SessionEnd and the new session's first prompt can race. Skip the clear when
    # the in-flight turn already belongs to this same session.
    if [ "$hook_event_name" = "session_start" ] && [ -f "$marker" ] &&
      [ -n "$hook_session_id" ] &&
      [ "$(cat "$turn_session_file" 2>/dev/null)" = "$hook_session_id" ]; then
      exit 0
    fi
    stop_watcher
    rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file"
    clear_subagents
    if [ "$hook_event_name" = "session_end" ]; then
      rm -f "$session_file" "$named_file"
    fi
    report cleared
    ;;
  running)
    # PostToolUse / PostToolUseFailure: a tool just finished mid-turn. Re-assert
    # `running` so a lingering `attention` (raised for a question grok answered
    # in its own TUI) drops back to "in progress" at once instead of staying
    # stuck until Stop. The marker and watcher are deliberately left untouched:
    # this is the same turn `started` set up, so its cancel detection must keep
    # running.
    if [ -f "$marker" ]; then
      report started
      summary="$(tool_summary "$input")"
      [ -n "$summary" ] || summary="Grok tool finished"
      message tool "$summary"
    fi
    ;;
  question)
    # PreToolUse on `ask_user_question`: grok is about to block on its own TUI
    # question prompt. Grok exposes no decision-returning hook for it, so this
    # raises a plain attention that the tool's PostToolUse clears once the user
    # answers in the terminal.
    if [ -f "$marker" ]; then
      qtext="$(question_text "$input")"
      report attention
      if [ -n "$qtext" ]; then
        content_message system "$qtext"
      else
        message system "Grok is asking a question"
      fi
    fi
    ;;
esac

exit 0
