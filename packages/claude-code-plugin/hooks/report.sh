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
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Per-tab files: the marker holds the active turn's token (presence = a turn is
# in flight); the pidfile holds the current watcher's pid so a new turn (or a
# normal end) can tear it down. Both are keyed on PRAGMA_TAB_ID.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
pidfile="${state_dir}/pragma-cli-${agent}-${tab}.watcher"
session_file="${state_dir}/pragma-cli-${agent}-${tab}.session"
# Holds the session_id whose name was already reported, so each session (incl.
# a /resume switch to another session) names the tab exactly once.
named_file="${state_dir}/pragma-cli-${agent}-${tab}.sessionname"
children_dir="${state_dir}/pragma-cli-${agent}-${tab}.subagents"
# The session id that owns the in-flight marker. `/clear` fires SessionEnd (old
# session) + SessionStart (new session) while the user's next prompt may already
# have started a turn in the NEW session; hook processes race, and a late
# `cleared` landing after that `started` would wipe the marker and mute every
# marker-guarded report for the rest of the turn. This file lets `cleared` tell
# a stale clear from a legitimate one.
turn_session_file="${state_dir}/pragma-cli-${agent}-${tab}.turn-session"

# Poll cadence and absolute lifetime backstop (overridable for tests). The
# backstop guarantees a watcher can't outlive its session forever if the session
# is killed uncatchably (SIGKILL) and the marker is never removed.
interval="${PRAGMA_WATCH_INTERVAL:-1}"
max_lifetime="${PRAGMA_WATCH_MAX:-86400}"
# How long a PermissionRequest blocks waiting for a remote approve/deny from a
# Pragma toast before giving up and letting Claude Code show its own prompt.
approval_timeout="${PRAGMA_APPROVAL_TIMEOUT:-300}"
dismissed_answer="__PRAGMA_QUESTION_DISMISSED__"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Claude Code session (e.g. when pragma-cli or the server is unavailable).
report() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

# Same as `report` but propagates the exit status. Use it for a report whose
# flags a older installed pragma-cli may not know (`--questions` landed after
# the hook did): clap exits nonzero on an unknown flag, and because `report`
# swallows that the attention silently never reaches any client while the
# chat message still arrives. Callers fall back on a nonzero status.
report_checked() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1
}

# Reports a coarse rich message. Hook payloads are intentionally not parsed here
# beyond existing transcript handling; this keeps hooks fail-open and portable.
# AgentMessage.ts is milliseconds since Unix epoch (see @pragma/constants).
# `date +%s` is seconds — multiply so chat clients that stamp local input with
# Date.now() don't sort every agent bubble above the user's messages.
message_ts_ms() {
  echo $(($(date +%s) * 1000))
}

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
# JSON parsing/escaping that POSIX sh cannot do safely; python3 ships with
# macOS and every mainstream Linux distro. When it's missing these helpers do
# nothing and the bridge degrades to the coarse status-only messages above.
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

# Prints the transcript path from a hook payload. Prefer real JSON parsing so
# Claude's whitespace and escaping are handled correctly; retain a portable
# fallback for hosts without python3.
transcript_path() {
  input="$1"
  value="$(json_field transcript_path "$input")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Prints a tab-title-sized session name derived from the prompt's first line.
# Silent no-op without python3 (the session simply stays unnamed).
session_name_from_prompt() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import sys
lines = sys.stdin.read().strip().splitlines()
line = lines[0].strip() if lines else ""
print(line if len(line) <= 48 else line[:47].rstrip() + "\u2026")
' 2>/dev/null
}

# Claude Code exposes no conversation title to hooks, so the session is named
# after its first real user prompt; switching sessions renames on that
# session's first prompt. Pragma preserves manual tab renames regardless.
report_session_name() {
  prompt_text="$1"
  [ -n "$hook_session_id" ] || return 0
  [ "$(cat "$named_file" 2>/dev/null)" = "$hook_session_id" ] && return 0
  session_name="$(session_name_from_prompt "$prompt_text")"
  [ -n "$session_name" ] || return 0
  report session-name --name "$session_name"
  printf '%s' "$hook_session_id" >"$named_file"
}

# Reports a rich message whose text is JSON-escaped (safe for arbitrary
# content). Silent no-op without python3 or when the text is empty.
content_message() {
  role="$1"
  text="$2"
  [ -n "$py3" ] && [ -n "$text" ] || return 0
  id="${agent}-${tab}-$(date +%s)-$$-$role"
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

# Prints the newest assistant text in a Claude Code transcript JSONL — the
# reply the turn that just stopped produced. Empty output when unavailable.
last_assistant_text() {
  tp="$1"
  [ -n "$py3" ] && [ -n "$tp" ] && [ -f "$tp" ] || return 0
  "$py3" -c '
import json, sys
last = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get("type") != "assistant":
        continue
    content = (obj.get("message") or {}).get("content") or []
    parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
    if any(parts):
        last = "\n".join(p for p in parts if p)
print(last)
' "$tp" 2>/dev/null
}

# Succeeds when a Stop payload reports at least one subagent still running in
# `background_tasks`. Such a Stop only ends the parent's *inference turn* — the
# session keeps working and Claude auto-resumes when the subagent finishes — so
# reporting `stopped` would flip the tab to done while agents are still active.
has_running_subagents() {
  [ -n "$py3" ] || return 1
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    tasks = (json.load(sys.stdin) or {}).get("background_tasks") or []
except Exception:
    tasks = []
running = any(
    isinstance(t, dict) and t.get("type") == "subagent" and t.get("status") == "running"
    for t in tasks
)
sys.exit(0 if running else 1)
' 2>/dev/null
}

# Claude's SubagentStart/SubagentStop hooks provide durable accounting when
# several children overlap. Stop.background_tasks is retained as a fallback.
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

# Prints the question text from an AskUserQuestion PermissionRequest payload
# ($1) when it carries exactly one question. Empty for multi-question payloads
# (one free-text reply can't answer them all -- those fall back to a generic
# attention + Claude's native question UI) or without python3.
question_text() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    questions = ((json.load(sys.stdin) or {}).get("tool_input") or {}).get("questions") or []
except Exception:
    questions = []
if len(questions) == 1 and isinstance(questions[0], dict):
    text = questions[0].get("question")
    if isinstance(text, str) and text:
        print(text)
' 2>/dev/null
}

# Prints the single question's answer choices as a QuestionOption JSON array
# (`[{"label": ..., "description": ...}]`) for `report attention --options`.
# Empty when there are no usable choices (the report degrades to free-text).
question_options() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    questions = ((json.load(sys.stdin) or {}).get("tool_input") or {}).get("questions") or []
except Exception:
    questions = []
options = []
if len(questions) == 1 and isinstance(questions[0], dict):
    for option in questions[0].get("options") or []:
        if isinstance(option, dict) and isinstance(option.get("label"), str) and option["label"]:
            entry = {"label": option["label"]}
            description = option.get("description")
            if isinstance(description, str) and description:
                entry["description"] = description
            options.append(entry)
if options:
    print(json.dumps(options))
' 2>/dev/null
}

# Prints every AskUserQuestion question as a Question JSON array
# (`[{"question": ..., "options": [...]}, ...]`) for `report attention
# --questions`. Empty when the payload carries fewer than two questions (the
# single-question path keeps the legacy `--question`/`--options` fields).
question_json() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    questions = ((json.load(sys.stdin) or {}).get("tool_input") or {}).get("questions") or []
except Exception:
    questions = []
entries = []
for question in questions:
    if not isinstance(question, dict):
        continue
    text = question.get("question")
    if not isinstance(text, str) or not text:
        continue
    entry = {"question": text, "options": []}
    for option in question.get("options") or []:
        if not isinstance(option, dict) or not isinstance(option.get("label"), str) or not option["label"]:
            continue
        item = {"label": option["label"]}
        description = option.get("description")
        if isinstance(description, str) and description:
            item["description"] = description
        entry["options"].append(item)
    entries.append(entry)
if len(entries) > 1:
    print(json.dumps(entries))
' 2>/dev/null
}

# Prints the PermissionRequest allow decision that feeds a remote reply ($2)
# back into AskUserQuestion: `updatedInput.answers` (keyed by question text) is
# how the permission component supplies collected answers, so Claude continues
# with the reply and never shows its terminal question UI.
question_allow_decision() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    tool_input = (json.load(sys.stdin) or {}).get("tool_input") or {}
except Exception:
    sys.exit(0)
questions = tool_input.get("questions") or []
if len(questions) != 1 or not isinstance(questions[0], dict):
    sys.exit(0)
text = questions[0].get("question")
if not isinstance(text, str) or not text:
    sys.exit(0)
updated = dict(tool_input)
updated["answers"] = {text: sys.argv[1]}
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PermissionRequest",
        "decision": {"behavior": "allow", "updatedInput": updated},
    }
}))
' "$2" 2>/dev/null
}

# Prints the PermissionRequest allow decision for a multi-question
# AskUserQuestion. The mobile wizard submits all answers on one ` | `-separated
# line; split it back into answers keyed by question text so Claude continues
# without ever showing its terminal question UI.
question_multi_allow_decision() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    tool_input = (json.load(sys.stdin) or {}).get("tool_input") or {}
except Exception:
    sys.exit(0)
questions = tool_input.get("questions") or []
parts = [part.strip() for part in sys.argv[1].split(" | ")]
if len(questions) < 2:
    sys.exit(0)
updated = dict(tool_input)
answers = {}
for index, question in enumerate(questions):
    if not isinstance(question, dict):
        continue
    text = question.get("question")
    if isinstance(text, str) and text and index < len(parts):
        answers[text] = parts[index]
updated["answers"] = answers
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PermissionRequest",
        "decision": {"behavior": "allow", "updatedInput": updated},
    }
}))
' "$2" 2>/dev/null
}

# AskUserQuestion arrives through the same blocking PermissionRequest hook as
# command approvals. Report it as a `question` attention (text + choices +
# requestId) so clients render an answer UI instead of a command toast showing
# raw tool JSON; block on `await-answer` and feed a reply back through an
# allow decision with pre-filled answers. Dismiss emits a deny decision so the
# native question closes; timeout emits nothing so Claude falls back to it.
handle_question() {
  input="$1"
  qjson="$(question_json "$input")"
  request_id="${agent}-${tab}-$(date +%s)-$$"
  if [ -n "$qjson" ]; then
    # Multi-question: mobile/desktop render a back/next wizard and submit one
    # ` | `-separated line. Report the questions array and feed the collected
    # answers back through updatedInput.answers.
    if ! report_checked attention --kind question --questions "$qjson" --request-id "$request_id"; then
      # Installed pragma-cli is older than this hook and rejects `--questions`.
      # Raise a generic attention and let Claude's own UI collect the answers
      # instead of blocking on a reply no client can ever send.
      report attention
      message system "Claude Code is asking questions"
      return 0
    fi
    message system "Claude Code is asking questions"
    answer="$("$pragma_cli" agent await-answer \
      --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" \
      --dismiss-output "$dismissed_answer" 2>/dev/null)"
    [ -n "$answer" ] || return 0
    if [ "$answer" = "$dismissed_answer" ]; then
      if [ -f "$marker" ]; then
        report started
        message system "Questions dismissed"
      fi
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
      return 0
    fi
    decision="$(question_multi_allow_decision "$input" "$answer")"
    [ -n "$decision" ] || return 0
    if [ -f "$marker" ]; then
      report started
      message system "Questions answered"
    fi
    printf '%s\n' "$decision"
    return 0
  fi

  qtext="$(question_text "$input")"
  if [ -z "$qtext" ]; then
    # Unparseable payload: raise a generic attention and let Claude's own UI
    # collect the answer.
    report attention
    message system "Claude Code is asking a question"
    return 0
  fi
  qopts="$(question_options "$input")"
  if [ -n "$qopts" ]; then
    report attention --kind question --question "$qtext" --options "$qopts" --request-id "$request_id"
  else
    report attention --kind question --question "$qtext" --request-id "$request_id"
  fi
  message system "Claude Code is asking a question"
  answer="$("$pragma_cli" agent await-answer \
    --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" \
    --dismiss-output "$dismissed_answer" 2>/dev/null)"
  [ -n "$answer" ] || return 0
  # The turn resumes the moment a reply (or dismissal) goes back to Claude, and
  # no hook is guaranteed to fire next (a deny never runs the tool, so no
  # PostToolUse). Re-assert `started` here so the tab drops back to "in
  # progress" instead of staying stuck on the question attention. Guarded on the
  # marker so a turn the abort watcher cleared meanwhile stays cleared.
  if [ "$answer" = "$dismissed_answer" ]; then
    if [ -f "$marker" ]; then
      report started
      message system "Question dismissed"
    fi
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
    return 0
  fi
  decision="$(question_allow_decision "$input" "$answer")"
  [ -n "$decision" ] || return 0
  if [ -f "$marker" ]; then
    report started
    message system "Question answered"
  fi
  printf '%s\n' "$decision"
}

# Extracts a human-readable command string from a PermissionRequest stdin JSON
# payload (passed as $1). Prefers `jq` for a faithful `tool_input.command`
# (Bash); falls back to the tool name when jq is absent or the tool has no
# command field, so the approval toast always shows *something* to approve.
extract_command() {
  input="$1"
  if [ -n "$py3" ]; then
    summary=$(printf '%s' "$input" | "$py3" -c '
import json, sys
try:
    payload = json.load(sys.stdin) or {}
except Exception:
    sys.exit(0)
tool_input = payload.get("tool_input") or {}
if isinstance(tool_input, str):
    try:
        tool_input = json.loads(tool_input)
    except Exception:
        tool_input = {}
if not isinstance(tool_input, dict):
    tool_input = {}
command = tool_input.get("command")
if isinstance(command, str) and command:
    print(command)
    sys.exit(0)
tool_name = payload.get("tool_name")
file_path = tool_input.get("file_path") or tool_input.get("filePath") or tool_input.get("path")
if tool_name in {"Read", "Write", "Edit"} and isinstance(file_path, str) and file_path:
    print(f"{tool_name} {file_path}")
' 2>/dev/null)
    if [ -n "$summary" ]; then
      printf '%s' "$summary"
      return 0
    fi
  fi
  if command -v jq >/dev/null 2>&1; then
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    if [ -n "$cmd" ]; then
      printf '%s' "$cmd"
      return 0
    fi
    name=$(printf '%s' "$input" | jq -r '.tool_name // "tool"' 2>/dev/null)
    path=$(printf '%s' "$input" | jq -r '
      (.tool_input // {})
      | if type == "string" then (try fromjson catch {}) else . end
      | .file_path // .filePath // .path // empty
    ' 2>/dev/null)
    case "$name" in
      Read|Write|Edit)
        if [ -n "$path" ]; then
          printf '%s %s' "$name" "$path"
          return 0
        fi
        ;;
    esac
    args=$(printf '%s' "$input" | jq -rc '
      (.tool_input // {})
      | if type == "string" then (try fromjson catch {}) else . end
    ' 2>/dev/null)
    printf '%s %s' "$name" "$args"
    return 0
  fi
  printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Grep pattern matching a real interrupt user message in transcript JSONL.
# The cancel line carries the marker as an *unescaped* top-level JSON string
# (`"text":"[Request interrupted by user…`). The same phrase embedded in tool
# output (e.g. Claude reading this very script) is nested inside another JSON
# string, so its quotes arrive backslash-escaped and must never match.
interrupt_pattern='"text":"\[Request interrupted by user'

# Succeeds when the most recent turn in the transcript ended in a user
# interruption (cancel/abort). The marker is written as the final user message
# of the cancelled turn, so we only inspect the tail -- an interruption earlier
# in a turn that later continued must not count (later lines push it out).
turn_interrupted() {
  tp="$1"
  [ -n "$tp" ] && [ -f "$tp" ] || return 1
  tail -n 5 "$tp" 2>/dev/null | grep -q "$interrupt_pattern"
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
  tail -c "+$((off + 1))" "$tp" 2>/dev/null | grep -q "$interrupt_pattern"
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
      rm -f "$marker" "$turn_session_file"
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

# Subagent hooks share the parent terminal environment, so without this guard a
# child Stop/PostToolUse can overwrite the parent turn's status. Current Claude
# adds `agent_id`; also recognize the explicit event and transcript fields for
# compatibility with payload variants. Consume stdin before any state mutation.
input="$(cat)"
hook_agent_id="$(json_field agent_id "$input")"
if [ -z "$hook_agent_id" ]; then
  hook_agent_id=$(printf '%s' "$input" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
hook_event_name="$(json_field hook_event_name "$input")"
agent_transcript_path="$(json_field agent_transcript_path "$input")"
if [ "${1:-}" = "subagent-start" ]; then
  track_subagent "$hook_agent_id"
  [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
  message system "Claude Code started a subagent"
  report started
  exit 0
fi
if [ "${1:-}" = "subagent-stop" ]; then
  untrack_subagent "$hook_agent_id"
  exit 0
fi
if [ -n "$hook_agent_id" ] || [ "$hook_event_name" = "SubagentStop" ] || [ -n "$agent_transcript_path" ]; then
  exit 0
fi

# Some Claude builds emit child completion as a plain Stop without any of the
# subagent fields above. The child still has its own session_id, so pin this tab
# to the parent session established by SessionStart/UserPromptSubmit and reject
# every event from a different session before it can alter parent status.
hook_session_id="$(json_field session_id "$input")"
case "$hook_event_name" in
  SessionStart|UserPromptSubmit)
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
    # turn's transcript and token.
    token="$$-$(date +%s)"
    printf '%s' "$token" >"$marker"
    printf '%s' "$hook_session_id" >"$turn_session_file"
    report started
    # UserPromptSubmit carries the user's prompt: surface it as the chat's user
    # bubble; fall back to the coarse status line when it can't be extracted.
    # Subagent completions auto-resume the parent through a synthetic
    # UserPromptSubmit whose prompt is a `<task-notification>` block the user
    # never typed -- report `started` for it but don't render a fake bubble.
    prompt="$(json_field prompt "$input")"
    case "$prompt" in
    "<task-notification>"* | "[SYSTEM NOTIFICATION"*)
      message system "Claude Code resumed after a subagent finished"
      ;;
    "")
      message assistant "Claude Code turn started"
      ;;
    *)
      content_message user "$prompt"
      report_session_name "$prompt"
      ;;
    esac
    stop_watcher
    tp="$(transcript_path "$input")"
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
    # `Stop` fires only on normal completion (never on a cancel). The
    # transcript check is a belt-and-suspenders for any build where Stop might
    # trail an interrupt.
    tp="$(transcript_path "$input")"
    if turn_interrupted "$tp"; then
      stop_watcher
      rm -f "$marker" "$turn_session_file"
      report cleared
      message system "Claude Code turn interrupted"
    elif has_running_subagents "$input" || has_tracked_subagents; then
      # The parent's inference turn ended, but background subagents are still
      # working and Claude auto-resumes (a synthetic UserPromptSubmit) when
      # they finish -- the session is NOT done. Stay on `started`, keep the
      # marker and abort watcher alive so a cancel during the subagent phase
      # is still detected, and surface the parent's interim reply.
      [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
      report started
      reply="$(json_field last_assistant_message "$input")"
      [ -n "$reply" ] || reply="$(last_assistant_text "$tp")"
      if [ -n "$reply" ]; then
        content_message assistant "$reply"
      else
        message assistant "Claude Code is waiting on subagents"
      fi
    else
      # Tear down the watcher, clear the in-flight marker, and report the
      # green "done" dot.
      stop_watcher
      rm -f "$marker" "$turn_session_file"
      report stopped
      # Stop carries the completed reply directly on current Claude builds.
      # Prefer it over rereading the transcript, then retain transcript support
      # for older builds that omit the field.
      reply="$(json_field last_assistant_message "$input")"
      [ -n "$reply" ] || reply="$(last_assistant_text "$tp")"
      if [ -n "$reply" ]; then
        content_message assistant "$reply"
      else
        message assistant "Claude Code turn completed"
      fi
    fi
    ;;
  cleared)
    # `/clear` fires SessionEnd + SessionStart while the user's next prompt may
    # already have started a turn in the NEW session. The session pinning above
    # discards the old session's late SessionEnd, but SessionStart re-pins to
    # its own (new) session id first — so a SessionStart landing *after* that
    # session's first `started` would wipe the live marker and mute every
    # marker-guarded report for the rest of the turn. Skip the clear when the
    # in-flight turn already belongs to this same session.
    if [ "$hook_event_name" = "SessionStart" ] && [ -f "$marker" ] &&
      [ -n "$hook_session_id" ] &&
      [ "$(cat "$turn_session_file" 2>/dev/null)" = "$hook_session_id" ]; then
      exit 0
    fi
    stop_watcher
    rm -f "$marker" "$turn_session_file"
    clear_subagents
    if [ "$hook_event_name" = "SessionEnd" ]; then
      rm -f "$session_file"
      rm -f "$named_file"
    fi
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
    if [ -f "$marker" ]; then
      report started
      message tool "Claude Code tool finished"
    fi
    ;;
  permission)
    # PermissionRequest: Claude is asking to run a tool and is BLOCKED on this
    # hook's stdout. AskUserQuestion routes through this same hook, so branch it
    # to the question flow (question attention + await-answer); everything else
    # reports a `command` attention carrying the command text and a unique
    # requestId, then blocks on `await-decision` for the verdict a Pragma
    # approval toast publishes. Emit Claude's PermissionRequest decision JSON so
    # an approve runs the tool and a deny rejects it -- all without the user
    # touching the terminal. On timeout (no one answered) emit nothing so Claude
    # falls back to its own native permission prompt. Guarded on the marker so a
    # stray request outside a turn can't wedge the hook.
    if [ -f "$marker" ]; then
      if [ "$(json_field tool_name "$input")" = "AskUserQuestion" ]; then
        handle_question "$input"
        exit 0
      fi
      command_text="$(extract_command "$input")"
      request_id="${agent}-${tab}-$(date +%s)-$$"
      report attention --kind command --command "$command_text" --request-id "$request_id"
      message system "Claude Code needs approval"
      verdict="$("$pragma_cli" agent await-decision \
        --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" 2>/dev/null)"
      # Either verdict resumes the turn at once. An allowed tool will also fire
      # PostToolUse when it finishes, but a denied one never runs — without this
      # re-assert the tab would stay stuck on the command attention until Stop.
      # Guarded on the marker so a turn the abort watcher cleared meanwhile
      # stays cleared.
      case "$verdict" in
        allow)
          [ -f "$marker" ] && report started
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          ;;
        deny)
          [ -f "$marker" ] && report started
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
          ;;
        *)
          # Timed out / no decision: defer to Claude's own prompt.
          :
          ;;
      esac
    fi
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
    if [ -f "$marker" ]; then
      report attention
      message system "Claude Code needs attention"
    fi
    ;;
  idle)
    # Idle-prompt notification. After a normal completion the marker is already
    # gone, so this is a no-op and the green "done" dot is preserved. (It does
    # not fire after a cancel -- the watcher handles those -- but if a future
    # Claude Code build emits it, a lingering marker still clears the turn.)
    if [ -f "$marker" ]; then
      stop_watcher
      rm -f "$marker" "$turn_session_file"
      report cleared
      message system "Claude Code turn cleared"
    fi
    ;;
esac

exit 0
