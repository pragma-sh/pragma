#!/usr/bin/env sh
# Pragma <-> GitHub Copilot CLI lifecycle bridge.

set -u

[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="github-copilot"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_prefix="${TMPDIR:-/tmp}/pragma-cli-${agent}-${tab}"
marker="${state_prefix}.active"
session_name_marker="${state_prefix}.named"
subagent_dir="${state_prefix}.subagents"
subagent_count_file="${subagent_dir}/count"
watcher_file="${state_prefix}.watcher"
messages_file="${state_prefix}.messages"
questions_file="${state_prefix}.questions"
approval_timeout="${PRAGMA_APPROVAL_TIMEOUT:-15}"
watch_interval="${PRAGMA_WATCH_INTERVAL:-1}"
watch_max="${PRAGMA_WATCH_MAX:-86400}"

report() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

json_string() {
  command -v jq >/dev/null 2>&1 || return 0
  printf '%s' "$2" | jq -r "$1 // empty | select(type == \"string\")" 2>/dev/null
}

message_ts_ms() {
  echo $(($(date +%s) * 1000))
}

active_subagent_count() {
  count=0
  if [ -f "$subagent_count_file" ]; then
    count="$(cat "$subagent_count_file" 2>/dev/null || echo 0)"
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
  fi
  printf '%s' "$count"
}

change_subagent_count() {
  delta="$1"
  count="$(active_subagent_count)"
  count=$((count + delta))
  [ "$count" -lt 0 ] && count=0
  mkdir -p "$subagent_dir"
  printf '%s' "$count" >"$subagent_count_file"
}

content_message() {
  role="$1"
  text="$2"
  stable_id="$3"
  [ -n "$text" ] && command -v jq >/dev/null 2>&1 || return 0
  payload=$(jq -cn \
    --arg id "$stable_id" \
    --arg role "$role" \
    --arg text "$text" \
    --argjson active "$(active_subagent_count)" \
    --argjson ts "$(message_ts_ms)" \
    '{id:$id,role:$role,text:$text,subAgentsActive:$active,ts:$ts}' 2>/dev/null)
  [ -n "$payload" ] || return 0
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

session_name_once() {
  prompt="$1"
  [ -n "$prompt" ] && [ ! -f "$session_name_marker" ] || return 0
  name=$(printf '%s' "$prompt" | sed -n '/[^[:space:]]/ { s/^[[:space:]]*//; s/[[:space:]]*$//; p; q; }')
  if [ "$(printf '%s' "$name" | wc -c | tr -d ' ')" -gt 48 ]; then
    name="$(printf '%s' "$name" | cut -c 1-48)"
  fi
  [ -n "$name" ] || return 0
  report session-name --name "$name"
  : >"$session_name_marker"
}

safe_id() {
  printf '%s' "$1" | cksum | tr -d '[:space:]'
}

clear_state() {
  stop_watcher
  rm -f "$marker" "$session_name_marker" "$messages_file" "$questions_file"
  if [ -d "$subagent_dir" ]; then
    rm -f "$subagent_dir"/*
    rmdir "$subagent_dir" 2>/dev/null || true
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

start_transcript_watcher() {
  transcript="$1"
  token="$2"
  stop_watcher
  nohup sh "$0" __watch "$transcript" "$token" >/dev/null 2>&1 &
  echo "$!" >"$watcher_file"
}

marker_session() {
  value="$(cat "$marker" 2>/dev/null || true)"
  printf '%s' "${value%%|*}"
}

sync_messages() {
  transcript="$1"
  token="$2"
  [ -f "$transcript" ] && command -v jq >/dev/null 2>&1 || return 0
  sent="$(cat "$messages_file" 2>/dev/null || echo 0)"
  case "$sent" in ''|*[!0-9]*) sent=0 ;; esac
  count=$(jq -cs '[.[] | select(.type == "assistant.message") | .data.content | select(type == "string" and length > 0)] | length' "$transcript" 2>/dev/null || echo 0)
  index="$sent"
  while [ "$index" -lt "$count" ]; do
    text=$(jq -rs --argjson index "$index" '[.[] | select(.type == "assistant.message") | .data.content | select(type == "string" and length > 0)][$index] // empty' "$transcript" 2>/dev/null || true)
    content_message assistant "$text" "github-copilot-${token}-assistant-${index}"
    index=$((index + 1))
  done
  printf '%s' "$count" >"$messages_file"
}

question_count() {
  transcript="$1"
  [ -f "$transcript" ] && command -v jq >/dev/null 2>&1 || {
    printf '0'
    return
  }
  jq -cs '[.[] | select(.type == "tool.execution_start" and .data.toolName == "ask_user")] | length' "$transcript" 2>/dev/null || printf '0'
}

initialize_question_cursor() {
  question_count "$1" >"$questions_file"
}

sync_questions() {
  transcript="$1"
  token="$2"
  [ -f "$transcript" ] && command -v jq >/dev/null 2>&1 || return 0
  sent="$(cat "$questions_file" 2>/dev/null || echo 0)"
  case "$sent" in ''|*[!0-9]*) sent=0 ;; esac
  count="$(question_count "$transcript")"
  index="$sent"
  while [ "$index" -lt "$count" ]; do
    question_data=$(jq -cs --argjson index "$index" '
      [
        .[]
        | select(.type == "tool.execution_start" and .data.toolName == "ask_user")
        | .data as $data
        | ($data.arguments // {}) as $args
        | ($args.requestedSchema.properties // {} | to_entries | .[0].value // {}) as $property
        | {
            id: ($data.toolCallId // ""),
            question: ($args.message // $property.title // "Copilot needs input"),
            options: [($property.enum // [])[] | {label: tostring}]
          }
      ][$index] // empty
    ' "$transcript" 2>/dev/null || true)
    if [ -n "$question_data" ]; then
      request_id="$(printf '%s' "$question_data" | jq -r '.id // empty')"
      question="$(printf '%s' "$question_data" | jq -r '.question // empty')"
      options="$(printf '%s' "$question_data" | jq -c '.options // []')"
      [ -n "$request_id" ] || request_id="${agent}-$(safe_id "${token}-${index}")"
      if [ "$options" = "[]" ]; then
        report attention --kind question --question "${question:-Copilot needs input}" --request-id "$request_id"
      else
        report attention --kind question --question "${question:-Copilot needs input}" --options "$options" --request-id "$request_id"
      fi
    fi
    index=$((index + 1))
  done
  printf '%s' "$count" >"$questions_file"
}

watch_transcript() {
  transcript="$1"
  token="$2"
  started_at="$(date +%s)"
  while :; do
    [ "$(cat "$marker" 2>/dev/null || true)" = "$token" ] || exit 0
    sync_messages "$transcript" "$token"
    sync_questions "$transcript" "$token"
    now="$(date +%s)"
    [ $((now - started_at)) -lt "$watch_max" ] || exit 0
    sleep "$watch_interval"
  done
}

extract_command() {
  input="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '
      (.toolName // "Copilot tool") as $name
      | (.toolInput // .toolArgs // {}) as $args
      | if ($args | type) == "object" and (($args.command // $args.path // $args.filePath) | type) == "string"
        then "\($name) \($args.command // $args.path // $args.filePath)"
        elif ($args | type) == "string" then "\($name) \($args)"
        else "\($name) \($args | tojson)" end
    ' 2>/dev/null
    return
  fi
  printf '%s' "$input" | sed -n 's/.*"toolName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

is_native_safe_command() {
  input="$1"
  command -v jq >/dev/null 2>&1 || return 1
  command_text=$(printf '%s' "$input" | jq -r '.toolInput.command // empty' 2>/dev/null)
  case "$command_text" in
    date|date\ *|pwd|whoami|uname|uname\ *) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  __watch)
    watch_transcript "${2:-}" "${3:-}"
    ;;
  session-start)
    input=$(cat)
    session_id="$(json_string '.sessionId' "$input")"
    # Copilot can deliver sessionStart after userPromptSubmitted. Preserve an
    # already-active first turn owned by that same session.
    if [ -f "$marker" ] && [ "$(marker_session)" = "$session_id" ]; then
      exit 0
    fi
    clear_state
    report cleared
    ;;
  session-end)
    clear_state
    report cleared
    ;;
  started)
    input=$(cat)
    session_id="$(json_string '.sessionId' "$input")"
    timestamp="$(printf '%s' "$input" | jq -r '.timestamp // empty' 2>/dev/null || true)"
    prompt="$(json_string '.prompt' "$input")"
    token="${session_id:-session}|${timestamp:-$(date +%s)}"
    transcript="${HOME:-}/.copilot/session-state/${session_id}/events.jsonl"
    stop_watcher
    rm -f "$messages_file"
    initialize_question_cursor "$transcript"
    printf '%s' "$token" >"$marker"
    # Start the transcript watcher before the slow report/message calls below:
    # the hook runs under Copilot's per-hook timeout (10s) and can be killed
    # mid-handler when the machine is loaded, and the watcher is the only path
    # that keeps reporting assistant messages and questions while the turn is
    # running. If it never starts, a message that lands just before agentStop
    # races Copilot's async transcript flush and is lost entirely.
    [ -n "$session_id" ] && start_transcript_watcher "$transcript" "$token"
    report started
    session_name_once "$prompt"
    content_message user "$prompt" "github-copilot-${token}-user"
    ;;
  stopped)
    [ -f "$marker" ] || exit 0
    if [ "$(active_subagent_count)" -gt 0 ]; then
      report started
      exit 0
    fi
    input=$(cat)
    token="$(cat "$marker" 2>/dev/null || echo session)"
    transcript="$(json_string '.transcriptPath' "$input")"
    if [ -z "$transcript" ]; then
      session_id="$(marker_session)"
      transcript="${HOME:-}/.copilot/session-state/${session_id}/events.jsonl"
    fi
    # Copilot appends transcript events asynchronously: the final assistant
    # reply can land in the file a beat after agentStop fires (the events are
    # timestamped in memory first). Retry briefly so a fast reply is not lost
    # to the flush race; stop once the file stops growing.
    last_count=0
    retries=0
    while [ "$retries" -lt 6 ]; do
      sync_messages "$transcript" "$token"
      count="$(cat "$messages_file" 2>/dev/null || echo 0)"
      case "$count" in ''|*[!0-9]*) count=0 ;; esac
      if [ "$retries" -gt 0 ] && [ "$count" -eq "$last_count" ]; then
        break
      fi
      last_count="$count"
      sleep 0.4
      retries=$((retries + 1))
    done
    # Hooks run concurrently: a follow-up turn's userPromptSubmitted can
    # replace the marker (and start a new transcript watcher) while this stop
    # is still in flight. Only tear down state that still belongs to this
    # turn — killing the newer watcher or clearing the newer marker would
    # lose the next turn's assistant messages entirely.
    if [ "$(cat "$marker" 2>/dev/null || true)" = "$token" ]; then
      stop_watcher
      rm -f "$marker" "$messages_file"
    fi
    report stopped
    ;;
  subagent-start)
    [ -f "$marker" ] || exit 0
    input=$(cat)
    name="$(json_string '.agentDisplayName' "$input")"
    timestamp="$(printf '%s' "$input" | jq -r '.timestamp // empty' 2>/dev/null || true)"
    change_subagent_count 1
    # Copilot can spawn several sub-agents of the same agent type in one turn
    # (same transcriptPath and agentName), so the marker must be a per-hook
    # count rather than a per-key file; the hook process pid keeps message ids
    # unique for concurrent children.
    content_message system "GitHub Copilot started ${name:-a subagent}" "github-copilot-subagent-$(safe_id "${name:-subagent}-${timestamp}-$$")"
    report started
    ;;
  subagent-stop)
    [ -f "$marker" ] || exit 0
    change_subagent_count -1
    report started
    ;;
  running)
    [ -f "$marker" ] && report started
    ;;
  error)
    input=$(cat)
    recoverable=$(printf '%s' "$input" | jq -r '.recoverable // false' 2>/dev/null || echo false)
    if [ "$recoverable" = "true" ] && [ -f "$marker" ]; then
      report started
    else
      rm -f "$marker"
      report cleared
    fi
    ;;
  permission)
    [ -f "$marker" ] || exit 0
    input=$(cat)
    # permissionRequest fires before Copilot's own rules, including for commands
    # its native policy considers safe. Defer known read-only utilities without
    # emitting false attention; empty hook output preserves native evaluation.
    is_native_safe_command "$input" && exit 0
    session="$(json_string '.sessionId' "$input")"
    timestamp="$(printf '%s' "$input" | jq -r '.timestamp // empty' 2>/dev/null || true)"
    request_id="${agent}-$(safe_id "${tab}-${session}-${timestamp}-$$")"
    command_text="$(extract_command "$input")"
    report attention --kind command --command "${command_text:-Copilot tool}" --request-id "$request_id"
    verdict=$("$pragma_cli" agent await-decision \
      --agent "$agent" --request-id "$request_id" --timeout "$approval_timeout" 2>/dev/null || true)
    case "$verdict" in
      allow)
        report started
        printf '%s\n' '{"behavior":"allow"}'
        ;;
      deny)
        report started
        printf '%s\n' '{"behavior":"deny","message":"Denied from Pragma"}'
        ;;
      *) : ;;
    esac
    ;;
esac

exit 0
