#!/usr/bin/env sh
# Pragma <-> JetBrains Junie CLI status bridge.
#
# Invoked by hooks/hooks.json on Junie lifecycle events (see the hook -> status
# table in AGENTS.md). Each event becomes a `pragma-cli` status report for the
# current Pragma terminal tab. Outside a Pragma terminal PRAGMA_SERVER_SOCKET /
# PRAGMA_DAEMON_SOCKET are unset and there is no server to talk to, so every
# event is a silent no-op -- except PermissionRequest, which answers `ask`
# instead, because Junie reads silence from a successful hook as approval.
#
# Junie's stdin envelope is snake_case (`hook_event_name`, `session_id`,
# `tool_name`, `tool_input`, `last_assistant_message`, ...), like Claude Code's.
# Two differences shape everything below:
#
#   * Only `SessionStart` and `UserPromptSubmit` carry `session_id`; `PreToolUse`,
#     `PermissionRequest`, `Stop`, `StopFailure` and `SessionEnd` do not. The
#     session id is therefore captured on the two events that have it and cached
#     per tab, and every later event reuses the cached one.
#   * There is no `transcript_path` at all. Junie writes its session log to
#     `<junie home>/sessions/<session_id>/events.jsonl`, which this script
#     resolves from the cached session id (SessionStart's `cwd` is Junie's own
#     home directory, so it is preferred when it actually holds `sessions/`).
#
# Abort handling (the hard part): an interrupted turn (Esc) fires no hook at all
# -- Junie runs `Stop` only for genuine completions. The cancel *is* recorded in
# `events.jsonl` as a `ResultBlockUpdatedEvent` with `"cancelled":true` (and a
# failed turn as `AgentTaskFailedEvent`), so `started` spawns one detached
# per-tab watcher that polls that file past this turn's starting byte offset.
# The same watcher streams Junie's assistant output mid-turn (see sync_messages)
# and raises its question attentions (see sync_questions): asking a question
# fires no hook either, it is only an `AskAsyncRequestUpdatedEvent` in that log.

set -u

# Outside Pragma there is no server to report to; every event is a silent no-op
# EXCEPT `permission`: Junie reads a hook that exits 0 with no decision as an
# approval, so silence would rubber-stamp the sensitive action without Pragma or
# its native prompt. Return `ask` (Junie's "show your own prompt" verdict) and
# only let the other events fall through silently.
if [ -z "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ]; then
  if [ "${1:-}" = "permission" ]; then
    printf '%s\n' '{"decision":"ask","reason":"Not running inside Pragma"}'
  fi
  exit 0
fi

agent="junie"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Per-tab files: the marker holds the active turn's token (presence = a turn is
# in flight); the pidfile holds the current watcher's pid so a new turn (or a
# normal end) can tear it down.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
pidfile="${state_dir}/pragma-cli-${agent}-${tab}.watcher"
# The parent session id, cached because most Junie hooks omit it.
session_file="${state_dir}/pragma-cli-${agent}-${tab}.session"
# Junie's own home directory, as reported by SessionStart's `cwd`.
home_file="${state_dir}/pragma-cli-${agent}-${tab}.home"
# Last session name reported for this tab, so a rename is sent once per change.
named_file="${state_dir}/pragma-cli-${agent}-${tab}.sessionname"
# The session id that owns the in-flight marker, so a late `cleared` from a
# superseded session cannot wipe a turn that already started in a new one.
turn_session_file="${state_dir}/pragma-cli-${agent}-${tab}.turn-session"
# Characters of assistant output already streamed for the active turn.
sent_file="${state_dir}/pragma-cli-${agent}-${tab}.sent"
# Event-log byte offset the active turn started at, so `stopped` can run the
# final message sync over the same window the watcher used.
offset_file="${state_dir}/pragma-cli-${agent}-${tab}.offset"
# Request id of the question this tab is currently blocked on, so the attention
# is raised once and cleared when Junie's own prompt resolves.
question_file="${state_dir}/pragma-cli-${agent}-${tab}.question"
# Scratch files the question scan writes its parsed fields into.
question_scratch="${state_dir}/pragma-cli-${agent}-${tab}.question-scan"

# Poll cadence and absolute lifetime backstop (overridable for tests). The
# backstop guarantees a watcher can't outlive its session forever if the session
# is killed uncatchably (SIGKILL) and the marker is never removed.
interval="${PRAGMA_WATCH_INTERVAL:-1}"
max_lifetime="${PRAGMA_WATCH_MAX:-86400}"
# How long a PermissionRequest blocks waiting for a remote approve/deny from a
# Pragma toast before deferring to Junie's own prompt. Junie's hook `timeout`
# for this event is set slightly higher in hooks.json so this wins the race.
approval_timeout="${PRAGMA_APPROVAL_TIMEOUT:-300}"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Junie session (e.g. when pragma-cli or the server is unavailable).
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
  payload='{"id":"'"$id"'","role":"'"$role"'","text":"'"$text"'","subAgentsActive":0,"ts":'"$ts"'}'
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

# Content-bearing messages (the user's prompt, the assistant's reply) need real
# JSON parsing/escaping that POSIX sh cannot do safely; python3 ships with macOS
# and every mainstream Linux distro, and the sibling hook bridges
# (claude-code-plugin, codex-plugin, grok-plugin) already depend on it the same
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

# Prints the directory Junie keeps this tab's session log in. Junie chdirs to
# its own home before running hooks, so SessionStart's `cwd` is the most
# reliable base; JUNIE_HOME and ~/.junie cover the rest.
session_dir() {
  sid="$(cat "$session_file" 2>/dev/null)"
  [ -n "$sid" ] || return 0
  for base in "$(cat "$home_file" 2>/dev/null)" "${JUNIE_HOME:-}" "$HOME/.junie"; do
    [ -n "$base" ] || continue
    if [ -d "$base/sessions/$sid" ]; then
      printf '%s/sessions/%s' "$base" "$sid"
      return 0
    fi
  done
  printf '%s/sessions/%s' "${JUNIE_HOME:-$HOME/.junie}" "$sid"
}

# Prints Junie's own generated task name for the session, which it writes to the
# event log as `AgentTaskNameUpdatedEvent`. Empty until Junie has named the task.
session_title() {
  events="$1"
  [ -n "$py3" ] && [ -n "$events" ] && [ -f "$events" ] || return 0
  "$py3" -c '
import json, sys
name = ""
try:
    with open(sys.argv[1], encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            try:
                record = json.loads(raw)
            except Exception:
                continue
            event = ((record.get("event") or {}).get("agentEvent") or {})
            if event.get("kind") == "AgentTaskNameUpdatedEvent":
                candidate = event.get("name")
                if isinstance(candidate, str) and candidate.strip():
                    name = candidate.strip()
except Exception:
    sys.exit(0)
print(name)
' "$events" 2>/dev/null
}

# Names the hosting tab after Junie's generated task name, falling back to the
# first prompt until Junie has produced one. Reported only when it changes, so a
# rename lands once per title. Pragma preserves manual tab renames.
report_session_name() {
  events="$1"
  fallback="$2"
  session_name="$(session_title "$events")"
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

# Prints a human-readable summary of a tool call from a PreToolUse or
# PermissionRequest payload.
tool_summary() {
  [ -n "$py3" ] || return 0
  printf '%s' "$1" | "$py3" -c '
import json, sys
try:
    payload = json.load(sys.stdin) or {}
except Exception:
    sys.exit(0)
name = payload.get("tool_name") or "tool"
tool_input = payload.get("tool_input")
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
path = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("filePath")
print(f"{name} {path}" if isinstance(path, str) and path else name)
' 2>/dev/null
}


# Succeeds when the event log recorded a cancelled or failed turn after `off`
# bytes -- i.e. this turn was interrupted or died. Scoped to this turn's tail so
# an earlier turn's record can never clear a new turn.
#
# Junie 26.8.10 records an interruption in one of two shapes, depending on how
# far the turn got: a cancel before any result block exists (Escape right after
# submit) writes only a top-level `CancelAgentEvent`, while a cancel after
# output started writes `ResultBlockUpdatedEvent` with `"cancelled":true` (and
# a failed turn writes `AgentTaskFailedEvent`). The watcher must match all
# three, or an early abort looks like the turn is still running.
aborted_since() {
  events="$1"
  off="${2:-0}"
  [ -n "$events" ] && [ -f "$events" ] || return 1
  [ -n "$off" ] || off=0
  tail -c "+$((off + 1))" "$events" 2>/dev/null |
    grep -q '"cancelled":true\|"kind":"AgentTaskFailedEvent"\|"kind":"CancelAgentEvent"'
}

# Streams the assistant text produced so far in this turn. Junie records its
# reply as a series of `*BlockUpdatedEvent` records keyed by `stepId`, each one
# a *replacement* for the previous state of that block -- so the text is rebuilt
# by keeping the newest record per stepId, in first-seen order, rather than
# concatenating every record.
assistant_text_since() {
  events="$1"
  off="${2:-0}"
  [ -n "$py3" ] && [ -n "$events" ] && [ -f "$events" ] || return 0
  "$py3" -c '
import json, sys

KINDS = {
    "MarkdownBlockUpdatedEvent": ("text", "markdown", "content"),
    "MessageBlockUpdatedEvent": ("text", "message", "content"),
    "TerminalBlockUpdatedEvent": ("details",),
    "ResultBlockUpdatedEvent": ("result",),
}

path, offset = sys.argv[1], int(sys.argv[2])
order = []
blocks = {}
try:
    with open(path, "rb") as handle:
        handle.seek(offset)
        for raw in handle:
            try:
                record = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                continue
            event = ((record.get("event") or {}).get("agentEvent") or {})
            fields = KINDS.get(event.get("kind"))
            if fields is None:
                continue
            text = next(
                (
                    event[field]
                    for field in fields
                    if isinstance(event.get(field), str) and event[field].strip()
                ),
                None,
            )
            if text is None:
                continue
            step_id = event.get("stepId")
            key = step_id if isinstance(step_id, str) and step_id else len(order)
            if key not in blocks:
                order.append(key)
            blocks[key] = text.strip()
except Exception:
    sys.exit(0)
sys.stdout.write("\n\n".join(blocks[key] for key in order))
' "$events" "$off" 2>/dev/null
}

# Emits the turn's assistant text under the stable id `junie-<token>-assistant`
# whenever it has grown since the last sync.
sync_messages() {
  events="$1"
  off="$2"
  token="$3"
  [ -n "$py3" ] || return 0
  text="$(assistant_text_since "$events" "$off")"
  [ -n "$text" ] || return 0
  sent="$(cat "$sent_file" 2>/dev/null)"
  [ -n "$sent" ] || sent=0
  length=${#text}
  [ "$length" -gt "$sent" ] || return 0
  content_message assistant "$text" "${agent}-${token}-assistant"
  printf '%s' "$length" >"$sent_file"
}

# Scans this turn's event log for the question(s) Junie is currently blocked on
# and writes the parsed data to the scratch files. Junie's `ask_user` and
# `ask_user_choice` tools do NOT fire `PreToolUse` -- they are recorded as
# `AskAsyncRequestUpdatedEvent` instead -- so the event log is the only place a
# hook bridge can see a question at all. Each record replaces the previous state
# of its `stepId`, so the newest record per step decides whether it is pending.
#
# When several questions are pending at once (one `ask_user_choice` call with
# multiple questions), they are reported as ONE multi-question attention so a
# remote client can answer them together: `.id` holds the first question's
# identifier (the attention's request id), `.sig` the full pending set (the
# report dedupe key), `.q` the first question's text, and `.multi` the
# `questions` JSON array for `report attention --questions`.
scan_question() {
  events="$1"
  off="${2:-0}"
  rm -f "${question_scratch}.id" "${question_scratch}.sig" "${question_scratch}.q"     "${question_scratch}.o" "${question_scratch}.multi"
  [ -n "$py3" ] && [ -n "$events" ] && [ -f "$events" ] || return 0
  "$py3" -c '
import json, sys

path, offset, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
order, blocks = [], {}
try:
    with open(path, "rb") as handle:
        handle.seek(offset)
        for raw in handle:
            try:
                record = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                continue
            event = ((record.get("event") or {}).get("agentEvent") or {})
            if event.get("kind") != "AskAsyncRequestUpdatedEvent":
                continue
            step_id = event.get("stepId")
            key = step_id if isinstance(step_id, str) and step_id else len(order)
            if key not in blocks:
                order.append(key)
            blocks[key] = event
except Exception:
    sys.exit(0)
pending = [blocks[key] for key in order if blocks[key].get("status") == "IN_PROGRESS"]
if not pending:
    sys.exit(0)
entries, ids = [], []
for event in pending:
    request = event.get("request") or {}
    question = request.get("question") or event.get("title")
    if not isinstance(question, str) or not question.strip():
        continue
    entry = {"question": question.strip()}
    options = []
    for option in request.get("options") or []:
        if not isinstance(option, dict):
            continue
        label = option.get("title") or option.get("id")
        if not isinstance(label, str) or not label.strip():
            continue
        choice = {"label": label.strip()}
        description = option.get("description")
        if isinstance(description, str) and description.strip():
            choice["description"] = description.strip()
        options.append(choice)
    if options:
        entry["options"] = options
    identifier = request.get("id") or event.get("stepId") or question
    entries.append(entry)
    ids.append(str(identifier))
if not entries:
    sys.exit(0)
first = entries[0]
with open(out + ".id", "w", encoding="utf-8") as handle:
    handle.write(ids[0])
with open(out + ".sig", "w", encoding="utf-8") as handle:
    handle.write(",".join(ids))
with open(out + ".q", "w", encoding="utf-8") as handle:
    handle.write(first["question"])
if len(entries) > 1:
    with open(out + ".multi", "w", encoding="utf-8") as handle:
        handle.write(json.dumps(entries))
elif "options" in first:
    with open(out + ".o", "w", encoding="utf-8") as handle:
        handle.write(json.dumps(first["options"]))
' "$events" "$off" "$question_scratch" 2>/dev/null
}

# Raises a `question` attention the first time Junie blocks on one (or on a
# batch of them), and drops the tab back to `started` once that question is
# resolved. The reply itself is typed into the TUI by the plugin's watcher:
# Junie exposes no hook that can answer.
sync_questions() {
  events="$1"
  off="$2"
  scan_question "$events" "$off"
  pending_id="$(cat "${question_scratch}.id" 2>/dev/null)"
  reported_id="$(cat "$question_file" 2>/dev/null)"
  if [ -n "$pending_id" ]; then
    # Dedupe on the whole pending set, so a batch that gains or loses a
    # question re-reports instead of being hidden by an unchanged first id.
    pending_sig="$(cat "${question_scratch}.sig" 2>/dev/null)"
    [ -n "$pending_sig" ] || pending_sig="$pending_id"
    [ "$pending_sig" = "$reported_id" ] && return 0
    qtext="$(cat "${question_scratch}.q" 2>/dev/null)"
    [ -n "$qtext" ] || return 0
    qopts="$(cat "${question_scratch}.o" 2>/dev/null)"
    multi="$(cat "${question_scratch}.multi" 2>/dev/null)"
    request_id="${agent}-${tab}-${pending_id}"
    if [ -n "$multi" ]; then
      # Older pragma-cli/server builds reject the `questions` wire field (the
      # report is dropped, which would hide the question entirely); fall back
      # to the first pending question as a plain single-question attention.
      if ! "$pragma_cli" agent report --agent "$agent" attention --kind question \
        --questions "$multi" --request-id "$request_id" >/dev/null 2>&1; then
        report attention --kind question --question "$qtext" \
          --options "${qopts:-[]}" --request-id "$request_id"
      fi
    elif [ -n "$qopts" ]; then
      report attention --kind question --question "$qtext" --options "$qopts" \
        --request-id "$request_id"
    else
      report attention --kind question --question "$qtext" --request-id "$request_id"
    fi
    content_message system "$qtext"
    printf '%s' "$pending_sig" >"$question_file"
    return 0
  fi
  if [ -n "$reported_id" ]; then
    rm -f "$question_file"
    [ -f "$marker" ] && report started
  fi
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
  events="$1"
  token="$2"
  offset="${3:-0}"
  deadline=$(($(date +%s) + max_lifetime))
  while :; do
    # Turn ended or was superseded -> nothing to clear, exit quietly.
    [ -f "$marker" ] || exit 0
    [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
    sync_messages "$events" "$offset" "$token"
    sync_questions "$events" "$offset"
    if aborted_since "$events" "$offset"; then
      # Re-check the token right before acting so we never clear a turn that
      # started in the gap between the poll and now.
      [ "$(cat "$marker" 2>/dev/null)" = "$token" ] || exit 0
      rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file" "$question_file" "$question_scratch".*
      report cleared
      exit 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || exit 0
    sleep "$interval"
  done
}

# The watcher re-enters this same script as a detached child via `__watch`.
if [ "${1:-}" = "__watch" ]; then
  run_watcher "$2" "$3" "${4:-0}"
  exit 0
fi

input="$(cat)"
hook_event_name="$(json_field hook_event_name "$input")"
hook_session_id="$(json_field session_id "$input")"

# Only SessionStart and UserPromptSubmit carry `session_id` (and SessionStart
# alone carries Junie's home directory as `cwd`); cache both so the events that
# omit them can still resolve this tab's session log.
case "$hook_event_name" in
  SessionStart | UserPromptSubmit)
    if [ -n "$hook_session_id" ]; then
      printf '%s' "$hook_session_id" >"$session_file"
    fi
    ;;
esac
if [ "$hook_event_name" = "SessionStart" ]; then
  junie_home="$(json_field cwd "$input")"
  if [ -n "$junie_home" ] && [ -d "$junie_home/sessions" ]; then
    printf '%s' "$junie_home" >"$home_file"
  fi
fi
[ -n "$hook_session_id" ] || hook_session_id="$(cat "$session_file" 2>/dev/null)"

case "${1:-}" in
  started)
    # A new turn is in flight. Tag the marker with a unique token, report
    # running, then replace any prior watcher with a fresh one bound to this
    # turn's event log and byte offset.
    token="$$-$(date +%s)"
    printf '%s' "$token" >"$marker"
    printf '%s' "$hook_session_id" >"$turn_session_file"
    rm -f "$sent_file" "$offset_file" "$question_file" "$question_scratch".*
    report started
    prompt="$(json_field prompt "$input")"
    if [ -n "$prompt" ]; then
      content_message user "$prompt"
    else
      message assistant "Junie turn started"
    fi
    events="$(session_dir)/events.jsonl"
    report_session_name "$events" "$prompt"
    stop_watcher
    # Pin the watcher to where the event log stands *now* so a prior turn's
    # records can't be mistaken for this turn's output or cancel.
    offset=0
    if [ -f "$events" ]; then
      offset=$(wc -c <"$events" 2>/dev/null | tr -d '[:space:]')
      [ -n "$offset" ] || offset=0
    fi
    printf '%s' "$offset" >"$offset_file"
    nohup sh "$0" __watch "$events" "$token" "$offset" >/dev/null 2>&1 &
    echo "$!" >"$pidfile"
    ;;
  stopped)
    # Junie fires Stop only when a turn really completed (a cancel fires
    # nothing), so a bare Stop with no in-flight marker must not create a
    # phantom done dot.
    if [ ! -f "$marker" ]; then
      exit 0
    fi
    token="$(cat "$marker" 2>/dev/null)"
    stop_watcher
    events="$(session_dir)/events.jsonl"
    offset="$(cat "$offset_file" 2>/dev/null)"
    [ -n "$offset" ] || offset=0
    # Final reply before `stopped`, so the reply event always precedes the done
    # report for chat consumers. `last_assistant_message` is Junie's own summary
    # of the finished turn and is preferred; the streamed event-log text is the
    # fallback for builds that omit it.
    reply="$(json_field last_assistant_message "$input")"
    [ -n "$reply" ] || reply="$(assistant_text_since "$events" "$offset")"
    [ -z "$reply" ] || content_message assistant "$reply" "${agent}-${token}-assistant"
    rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file" "$question_file" "$question_scratch".*
    report stopped
    report_session_name "$events" ""
    ;;
  failed)
    # StopFailure: the turn ended on an LLM/API error, so it never completed.
    # Clear rather than report done.
    if [ -f "$marker" ]; then
      stop_watcher
      rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file" "$question_file" "$question_scratch".*
      report cleared
      detail="$(json_field error "$input")"
      [ -n "$detail" ] || detail="unknown error"
      message system "Junie turn failed ($detail)"
    fi
    ;;
  cleared)
    # SessionStart fires for a brand new session (startup, `/clear`, resume,
    # compaction) while the previous session's SessionEnd and the new session's
    # first prompt can race. Skip the clear when the in-flight turn already
    # belongs to this same session.
    if [ "$hook_event_name" = "SessionStart" ] && [ -f "$marker" ] &&
      [ -n "$hook_session_id" ] &&
      [ "$(cat "$turn_session_file" 2>/dev/null)" = "$hook_session_id" ]; then
      exit 0
    fi
    stop_watcher
    rm -f "$marker" "$turn_session_file" "$sent_file" "$offset_file" "$question_file" "$question_scratch".*
    if [ "$hook_event_name" = "SessionEnd" ]; then
      rm -f "$session_file" "$named_file" "$home_file"
    fi
    report cleared
    ;;
  pre-tool)
    # PreToolUse fires before *every* tool call and is Junie's only mid-turn
    # signal (it has no PostToolUse hook), so it doubles as the "still running"
    # heartbeat that drops a resolved `attention` back to "in progress".
    if [ ! -f "$marker" ]; then
      exit 0
    fi
    tool_name="$(json_field tool_name "$input")"
    case "$tool_name" in
      ask_user | ask_user_choice)
        # Junie's question tools are dispatched through its own async-request
        # channel, not the tool pipeline: verified on 26.8.3, asking a question
        # fires no `PreToolUse` at all and only writes an
        # `AskAsyncRequestUpdatedEvent` to the event log, which the per-turn
        # watcher picks up (see sync_questions). This arm exists so that a build
        # which *does* route them here cannot re-assert `started` over a live
        # question attention.
        :
        ;;
      submit)
        # The `submit` tool is Junie's turn terminator and is immediately
        # followed by Stop; reporting anything for it only races that Stop.
        :
        ;;
      *)
        report started
        summary="$(tool_summary "$input")"
        [ -n "$summary" ] || summary="Junie tool call"
        message tool "$summary"
        ;;
    esac
    ;;
  permission)
    # PermissionRequest: Junie is asking to run a sensitive action and is BLOCKED
    # on this hook's stdout. Report a `command` attention carrying the command
    # text and a unique requestId, then block on `await-decision` for the verdict
    # a Pragma approval toast publishes.
    #
    # The timeout branch matters here in a way it does not for Claude Code: for
    # Junie, a hook that exits 0 without a decision *auto-approves* the action.
    # Emitting nothing would therefore silently bypass the user's own approval,
    # so an unanswered request returns `ask`, which is Junie's "show your native
    # prompt" verdict.
    if [ -f "$marker" ]; then
      command_text="$(tool_summary "$input")"
      [ -n "$command_text" ] || command_text="$(json_field tool_name "$input")"
      request_id="${agent}-${tab}-$(date +%s)-$$"
      report attention --kind command --command "$command_text" --request-id "$request_id"
      message system "Junie needs approval"
      verdict="$("$pragma_cli" agent await-decision \
        --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" 2>/dev/null)"
      # Either verdict resumes the turn at once. An allowed action fires a
      # PreToolUse when it runs, but a denied one never does -- without this
      # re-assert the tab would stay stuck on the command attention until Stop.
      # Guarded on the marker so a turn the abort watcher cleared meanwhile
      # stays cleared.
      case "$verdict" in
        allow)
          [ -f "$marker" ] && report started
          printf '%s\n' '{"decision":"allow","reason":"Approved in Pragma"}'
          ;;
        deny)
          [ -f "$marker" ] && report started
          printf '%s\n' '{"decision":"deny","reason":"Denied in Pragma"}'
          ;;
        *)
          # Timed out / no decision: hand the request back to Junie's own prompt
          # rather than letting silence auto-approve it.
          printf '%s\n' '{"decision":"ask","reason":"No Pragma decision"}'
          ;;
      esac
    else
      # No in-flight turn is tracked (e.g. Junie was started outside Pragma, or
      # the marker was lost), yet silence still means approve. Defer to Junie's
      # own prompt.
      printf '%s\n' '{"decision":"ask","reason":"No Pragma turn is tracked"}'
    fi
    ;;
esac

exit 0
