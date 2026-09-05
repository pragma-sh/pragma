#!/usr/bin/env sh
# Pragma <-> OpenAI Codex CLI lifecycle bridge.

set -u

[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

# Runtime stream id: the FINAL segment of the resolved catalog id
# (`pragma.codex`). Chat consumers (mobile `runtimeAgentId`, watcher `agentId`)
# filter the event stream by this bare id — a qualified id here silently drops
# every report/message on their end.
agent="codex"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
state_prefix="${state_dir}/pragma-cli-codex-${tab}"
marker="${state_prefix}.active"
offset_file="${state_prefix}.offset"
watcher_file="${state_prefix}.watcher"
question_file="${state_prefix}.question"
messages_file="${state_prefix}.messages"
session_name_marker="${state_prefix}.named"
subagent_dir="${state_prefix}.subagents"
approval_timeout="${PRAGMA_APPROVAL_TIMEOUT:-300}"
watch_interval="${PRAGMA_WATCH_INTERVAL:-1}"
watch_max="${PRAGMA_WATCH_MAX:-86400}"
py3="$(command -v python3 2>/dev/null || true)"
# Being on PATH is not proof of being usable: Windows ships an App Execution
# Alias at ~/AppData/Local/Microsoft/WindowsApps/python3 that only prints
# "Python was not found" and exits nonzero. That satisfies `command -v`, so the
# emptiness checks would wrongly take the has-python branch. Run it once and
# drop it unless it actually executes.
if [ -n "$py3" ] && ! "$py3" -c '' >/dev/null 2>&1; then
  py3=""
fi
interrupt_pattern='"type":"turn_aborted"'

report() {
  # Parallel tools and children must not clear another command's approval.
  if [ "${1:-}" = started ] && [ -f "$marker" ] &&
    [ -d "${state_prefix}.approval-$(safe_id "$(cat "$marker" 2>/dev/null)")" ]; then
    return 0
  fi
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

message_ts_ms() {
  echo $(($(date +%s) * 1000))
}

json_field() {
  [ -n "$py3" ] || return 0
  printf '%s' "$2" | "$py3" -c '
import json, sys
try:
    value = json.load(sys.stdin)
    for key in sys.argv[1].split("."):
        value = value.get(key) if isinstance(value, dict) else None
except Exception:
    value = None
if isinstance(value, str):
    print(value)
' "$1" 2>/dev/null
}

json_value() {
  [ -n "$py3" ] || return 0
  printf '%s' "$2" | "$py3" -c '
import json, sys
try:
    value = json.load(sys.stdin)
    for key in sys.argv[1].split("."):
        value = value.get(key) if isinstance(value, dict) else None
except Exception:
    value = None
if value is not None:
    print(json.dumps(value, separators=(",", ":")))
' "$1" 2>/dev/null
}

content_message() {
  role="$1"
  text="$2"
  stable_id="$3"
  [ -n "$py3" ] && [ -n "$text" ] || return 0
  ts="$(message_ts_ms)"
  active="$(active_subagent_count)"
  payload=$("$py3" -c '
import json, sys
print(json.dumps({
    "id": sys.argv[1],
    "role": sys.argv[2],
    "text": sys.argv[3],
    "subAgentsActive": int(sys.argv[4]),
    "ts": int(sys.argv[5]),
}))
' "$stable_id" "$role" "$text" "$active" "$ts" 2>/dev/null)
  [ -n "$payload" ] || return 0
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

report_session_name_once() {
  prompt="$1"
  [ -n "$prompt" ] && [ ! -f "$session_name_marker" ] || return 0
  name=$(printf '%s' "$prompt" | sed -n '/[^[:space:]]/ { s/^[[:space:]]*//; s/[[:space:]]*$//; p; q; }')
  if [ "$(printf '%s' "$name" | wc -c | tr -d ' ')" -gt 48 ]; then
    name="$(printf '%s' "$name" | cut -c 1-47)…"
  fi
  name=$(printf '%s' "$name" | sed 's/[[:space:]]*$//')
  [ -n "$name" ] || return 0
  report session-name --name "$name"
  : >"$session_name_marker"
}

safe_id() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

active_subagent_count() {
  [ -d "$subagent_dir" ] || {
    echo 0
    return
  }
  set -- "$subagent_dir"/*
  if [ -e "$1" ]; then
    echo "$#"
  else
    echo 0
  fi
}

stop_watcher() {
  if [ -f "$watcher_file" ]; then
    pid="$(cat "$watcher_file" 2>/dev/null || true)"
    case "$pid" in
      ''|*[!0-9]*) : ;;
      *) kill "$pid" 2>/dev/null || true ;;
    esac
    rm -f "$watcher_file"
  fi
}

clear_state() {
  stop_watcher
  rm -f "$marker" "$offset_file" "$question_file" "$messages_file"
  rm -rf "$subagent_dir"
}

transcript_offset() {
  path="$1"
  if [ -n "$path" ] && [ -f "$path" ]; then
    wc -c <"$path" | tr -d ' '
  else
    echo 0
  fi
}

interrupted_since() {
  path="$1"
  offset="$2"
  [ -n "$path" ] && [ -f "$path" ] || return 1
  tail -c "+$((offset + 1))" "$path" 2>/dev/null | grep -q "$interrupt_pattern"
}

question_snapshot() {
  path="$1"
  offset="$2"
  [ -n "$py3" ] && [ -n "$path" ] && [ -f "$path" ] || return 0
  "$py3" - "$path" "$offset" <<'PY' 2>/dev/null
import json
import sys

path, offset = sys.argv[1], int(sys.argv[2])
pending = {}
with open(path, "rb") as transcript:
    transcript.seek(offset)
    lines = transcript.read().decode("utf-8", errors="ignore").splitlines()

for line in lines:
    try:
        item = json.loads(line)
    except Exception:
        continue
    if item.get("type") != "response_item" or not isinstance(item.get("payload"), dict):
        continue
    payload = item["payload"]
    if payload.get("type") == "function_call" and payload.get("name") == "request_user_input":
        call_id = payload.get("call_id") or payload.get("id")
        arguments = payload.get("arguments")
        try:
            arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
        except Exception:
            continue
        questions = arguments.get("questions") if isinstance(arguments, dict) else None
        if not isinstance(call_id, str) or not isinstance(questions, list) or not questions:
            continue
        parsed = []
        for question in questions:
            if not isinstance(question, dict):
                continue
            text = question.get("question")
            if not isinstance(text, str) or not text.strip():
                continue
            options = []
            for option in question.get("options", []):
                if not isinstance(option, dict) or not isinstance(option.get("label"), str):
                    continue
                normalized = {"label": option["label"]}
                if isinstance(option.get("description"), str):
                    normalized["description"] = option["description"]
                options.append(normalized)
            parsed.append({"question": text, "options": options})
        if not parsed:
            continue
        entry = {"state": "pending", "requestId": call_id}
        if len(parsed) == 1:
            entry["question"] = parsed[0]["question"]
            entry["options"] = parsed[0]["options"]
        else:
            # Multi-question requests ride on the `questions` field; the
            # legacy single-question fields stay for exactly one question.
            entry["questions"] = parsed
        pending[call_id] = entry
    elif payload.get("type") == "function_call_output":
        call_id = payload.get("call_id")
        if isinstance(call_id, str):
            pending.pop(call_id, None)

print(json.dumps(next(reversed(pending.values())) if pending else {"state": "none"}))
PY
}

sync_question() {
  transcript="$1"
  offset="$2"
  snapshot="$(question_snapshot "$transcript" "$offset")"
  state="$(json_field state "$snapshot")"
  current="$(cat "$question_file" 2>/dev/null || true)"
  if [ "$state" = "pending" ]; then
    request_id="$(json_field requestId "$snapshot")"
    [ -n "$request_id" ] || return 0
    [ "$request_id" = "$current" ] && return 0
    multi="$(json_value questions "$snapshot")"
    question="$(json_field question "$snapshot")"
    options="$(json_value options "$snapshot")"
    reported=""
    if [ "$multi" != "null" ] && [ -n "$multi" ]; then
      # An installed pragma-cli older than this hook rejects `--questions`, and
      # `report` swallows that — the attention would silently never reach any
      # client. Fall back to the first question as a single-question attention.
      if "$pragma_cli" agent report --agent "$agent" attention --kind question \
        --questions "$multi" --request-id "$request_id" >/dev/null 2>&1; then
        reported="yes"
      fi
    fi
    if [ -z "$reported" ]; then
      report attention --kind question --question "$question" --options "${options:-[]}" --request-id "$request_id"
    fi
    printf '%s' "$request_id" >"$question_file"
  elif [ "$state" = "none" ] && [ -n "$current" ]; then
    rm -f "$question_file"
    report started
  fi
}

# Streams completed assistant messages out of the turn-scoped rollout window.
# Codex records one unescaped `event_msg`/`agent_message` line per finished
# assistant message (raw Markdown), so interim replies reach Pragma while the
# turn is still running instead of only after `Stop`. Already-sent messages are
# tracked by count in $messages_file; indexes are zero-padded so same-timestamp
# batches sort correctly on consumers that tiebreak by id.
sync_messages() {
  transcript="$1"
  offset="$2"
  token="$3"
  [ -n "$py3" ] && [ -n "$transcript" ] && [ -f "$transcript" ] || return 0
  active="$(active_subagent_count)"
  ts="$(message_ts_ms)"
  "$py3" - "$transcript" "$offset" "$messages_file" "codex-${token}-assistant" "$active" "$ts" 2>/dev/null <<'PY' |
import json
import sys

path, offset, sent_path, id_prefix, active, ts = sys.argv[1:7]
try:
    with open(sent_path, encoding="utf-8") as handle:
        sent = int(handle.read().strip() or "0")
except Exception:
    sent = 0

with open(path, "rb") as transcript:
    transcript.seek(int(offset))
    lines = transcript.read().decode("utf-8", errors="ignore").splitlines()

messages = []
for line in lines:
    try:
        item = json.loads(line)
    except Exception:
        continue
    payload = item.get("payload")
    if item.get("type") != "event_msg" or not isinstance(payload, dict):
        continue
    if payload.get("type") != "agent_message":
        continue
    text = payload.get("message")
    if isinstance(text, str) and text.strip():
        messages.append(text)

for index, text in enumerate(messages):
    if index < sent:
        continue
    print(json.dumps({
        "id": f"{id_prefix}-{index:03d}",
        "role": "assistant",
        "text": text,
        "subAgentsActive": int(active),
        "ts": int(ts),
    }, separators=(",", ":")))

with open(sent_path, "w", encoding="utf-8") as handle:
    handle.write(str(len(messages)))
PY
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
    done
}

start_abort_watcher() {
  transcript="$1"
  token="$2"
  offset="$3"
  [ -n "$transcript" ] && [ -f "$transcript" ] || return 0
  stop_watcher
  nohup sh "$0" __watch "$transcript" "$token" "$offset" >/dev/null 2>&1 &
  echo "$!" >"$watcher_file"
}

extract_command() {
  input="$1"
  if [ -n "$py3" ]; then
    printf '%s' "$input" | "$py3" -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    value = {}
tool = value.get("tool_name") or "Codex tool"
args = value.get("tool_input")
if isinstance(args, str):
    detail = args
elif isinstance(args, dict):
    detail = args.get("command") or args.get("description")
    if not isinstance(detail, str):
        detail = json.dumps(args, separators=(",", ":"), sort_keys=True)
else:
    detail = ""
print(f"{tool} {detail}".strip())
' 2>/dev/null
    return
  fi
  printf '%s' "$input" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p' | head -n 1
}

watch_abort() {
  transcript="$1"
  token="$2"
  offset="$3"
  started_at="$(date +%s)"
  while :; do
    current="$(cat "$marker" 2>/dev/null || true)"
    [ "$current" = "$token" ] || exit 0
    if interrupted_since "$transcript" "$offset"; then
      current="$(cat "$marker" 2>/dev/null || true)"
      [ "$current" = "$token" ] || exit 0
      rm -f "$marker" "$offset_file" "$watcher_file" "$question_file" "$messages_file"
      rm -rf "$subagent_dir"
      report cleared
      exit 0
    fi
    sync_messages "$transcript" "$offset" "$token"
    sync_question "$transcript" "$offset"
    now="$(date +%s)"
    [ $((now - started_at)) -lt "$watch_max" ] || exit 0
    sleep "$watch_interval"
  done
}

case "${1:-}" in
  __watch)
    watch_abort "${2:-}" "${3:-}" "${4:-0}"
    ;;
  cleared)
    clear_state
    rm -f "$session_name_marker"
    report cleared
    ;;
  started)
    input="$(cat)"
    turn_id="$(json_field turn_id "$input")"
    transcript="$(json_field transcript_path "$input")"
    prompt="$(json_field prompt "$input")"
    token="${turn_id:-$$-$(date +%s)}"
    offset="$(transcript_offset "$transcript")"
    stop_watcher
    rm -rf "$subagent_dir"
    rm -f "$question_file" "$messages_file"
    printf '%s' "$token" >"$marker"
    printf '%s' "$offset" >"$offset_file"
    # Start the abort watcher BEFORE the slow pragma-cli reports below. Codex
    # kills the in-flight UserPromptSubmit hook when the turn is aborted (ESC),
    # and an abort can land within milliseconds of the prompt — if the watcher
    # only started after `report started`/`session-name`/`content_message`
    # (several pragma-cli round-trips), a fast abort killed the hook first and
    # the transcript's `turn_aborted` marker was never scanned, so the status
    # stayed `running` forever.
    start_abort_watcher "$transcript" "$token" "$offset"
    report started
    if [ -n "$prompt" ]; then
      report_session_name_once "$prompt"
      content_message user "$prompt" "codex-${token}-user"
    fi
    ;;
  stopped)
    [ -f "$marker" ] || exit 0
    input="$(cat)"
    transcript="$(json_field transcript_path "$input")"
    offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
    if interrupted_since "$transcript" "$offset"; then
      clear_state
      report cleared
      exit 0
    fi
    if [ "$(active_subagent_count)" -gt 0 ]; then
      report started
      exit 0
    fi
    token="$(cat "$marker" 2>/dev/null || echo unknown)"
    stop_watcher
    # Final transcript sync catches messages the watcher had not polled yet,
    # and lands the reply BEFORE the done report so consumers stream in order.
    sync_messages "$transcript" "$offset" "$token"
    sent="$(cat "$messages_file" 2>/dev/null || echo 0)"
    if [ "${sent:-0}" = 0 ]; then
      # No transcript (or no python3): fall back to the Stop payload's reply.
      reply="$(json_field last_assistant_message "$input")"
      if [ -n "$reply" ]; then
        content_message assistant "$reply" "codex-${token}-assistant"
      fi
    fi
    rm -f "$marker" "$offset_file" "$question_file" "$messages_file"
    report stopped
    ;;
  subagent-start)
    input="$(cat)"
    child="$(json_field agent_id "$input")"
    if [ -n "$child" ] && [ -f "$marker" ]; then
      mkdir -p "$subagent_dir"
      : >"$subagent_dir/$(safe_id "$child")"
      content_message system "Codex started a subagent" "codex-${token:-session}-subagent-$(safe_id "$child")"
      report started
    fi
    ;;
  subagent-stop)
    input="$(cat)"
    child="$(json_field agent_id "$input")"
    if [ -n "$child" ]; then
      rm -f "$subagent_dir/$(safe_id "$child")"
      rmdir "$subagent_dir" 2>/dev/null || true
    fi
    if [ -f "$marker" ]; then
      report started
    fi
    ;;
  running)
    if [ -f "$marker" ]; then
      report started
    fi
    ;;
  permission)
    [ -f "$marker" ] || exit 0
    input="$(cat)"
    permission_token="$(cat "$marker" 2>/dev/null || true)"
    [ -n "$permission_token" ] || exit 0
    permission_lock="${state_prefix}.approval-$(safe_id "$permission_token")"
    # Pragma exposes one attention request per agent/tab. Queue concurrent
    # PermissionRequest hooks so every command keeps its own visible request
    # until its decision arrives. Scope the lock to the turn so an aborted
    # hook cannot block or clear a later turn's approval.
    while ! mkdir "$permission_lock" 2>/dev/null; do
      [ "$(cat "$marker" 2>/dev/null || true)" = "$permission_token" ] || exit 0
      sleep "$watch_interval"
    done
    trap 'rmdir "$permission_lock" 2>/dev/null || true' 0
    trap 'exit 0' HUP INT TERM
    [ "$(cat "$marker" 2>/dev/null || true)" = "$permission_token" ] || exit 0
    command_text="$(extract_command "$input")"
    turn_id="$(json_field turn_id "$input")"
    request_id="${agent}-$(safe_id "${tab}-${turn_id:-$(date +%s)}-$$")"
    report attention --kind command --command "$command_text" --request-id "$request_id"
    verdict="$("$pragma_cli" agent await-decision \
      --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" 2>/dev/null || true)"
    rmdir "$permission_lock" 2>/dev/null || true
    trap - 0
    [ "$(cat "$marker" 2>/dev/null || true)" = "$permission_token" ] || exit 0
    case "$verdict" in
      allow)
        report started
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        ;;
      deny)
        report started
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Pragma"}}}'
        ;;
      *) : ;;
    esac
    ;;
esac

exit 0
