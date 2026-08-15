#!/usr/bin/env sh
# Pragma <-> Kimi Code status bridge.
#
# Invoked by kimi.plugin.json on Kimi lifecycle events (see the hook -> status
# table in AGENTS.md). Each event is translated into a `pragma-cli` status
# report for the current Pragma terminal tab. Outside a Pragma terminal
# PRAGMA_SERVER_SOCKET / PRAGMA_DAEMON_SOCKET are unset and there is no server
# to talk to, so every event is a silent no-op (exit 0).
#
# Unlike Claude Code and Grok, Kimi has a first-class cancel hook: the TUI's
# Esc/Ctrl+C cancels the running turn through the RPC `session.cancel()` path,
# which fires `Interrupt`, and `Stop` fires only for genuine completions
# (`StopFailure` covers API/step errors). Every terminal state has a hook, so
# this bridge is purely event-driven -- there is no transcript-abort watcher.
#
# Kimi's stdin envelope is snake_case throughout (`hook_event_name`,
# `session_id`, `tool_name`, ...), the same convention as Claude Code. The one
# kimi-specific quirk: `UserPromptSubmit` carries `prompt` as a ContentPart
# array (not a string), so its text parts must be joined before use.
#
# Subagents run their own agent scope but share the parent session id and add
# no distinguishing field (parallel subagents even share the default profile
# name), so they are accounted for explicitly: the SubagentStart/SubagentStop
# hooks maintain an active-child count, and a Stop/StopFailure arriving while
# children are tracked is a subagent turn ending -- never a parent completion --
# so the tab stays on `started` until the parent's own Stop.

set -u

# Outside Pragma there is no server to report to; every event is a silent no-op.
[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

agent="kimi"
pragma_cli="${PRAGMA_CLI:-pragma-cli}"
tab="${PRAGMA_TAB_ID:-unknown}"
state_dir="${TMPDIR:-/tmp}"
# Per-tab files: the marker holds the active turn's token (presence = a turn is
# in flight); the pidfile-free design needs no watcher state beyond this.
marker="${state_dir}/pragma-cli-${agent}-${tab}.active"
session_file="${state_dir}/pragma-cli-${agent}-${tab}.session"
# The session id that owns the in-flight marker, so a late `cleared` from a
# superseded session cannot wipe a turn that already started in a new one.
turn_session_file="${state_dir}/pragma-cli-${agent}-${tab}.turn-session"
# Holds the session_id whose name was already reported, so each session (incl.
# a resume switch to another session) names the tab exactly once.
named_file="${state_dir}/pragma-cli-${agent}-${tab}.sessionname"

# Reports a status to Pragma, swallowing every failure so a hook never disrupts
# a Kimi session (e.g. when pragma-cli or the server is unavailable).
report() {
  "$pragma_cli" agent report --agent "$agent" "$@" >/dev/null 2>&1 || true
}

# Reports a coarse rich message. Hook payloads are intentionally not parsed
# beyond the prompt extraction below; this keeps hooks fail-open and portable.
# AgentMessage.ts is milliseconds since Unix epoch (see @pragma/constants).
# `date +%s` is seconds -- multiply so chat clients that stamp local input with
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

# Content-bearing messages (the user's prompt) need real JSON parsing/escaping
# that POSIX sh cannot do safely. Kimi itself ships as an npm package, so any
# machine that can run `kimi` already has a working `node` on PATH -- unlike
# python3, this adds no dependency beyond what Kimi already requires. When
# node is missing these helpers do nothing and the bridge degrades to the
# coarse status-only messages above.
node_bin="$(command -v node 2>/dev/null || true)"
if [ -n "$node_bin" ] && ! "$node_bin" -e 'process.exit(0)' >/dev/null 2>&1; then
  node_bin=""
fi

# Prints a top-level string field from the JSON document passed as $2.
json_field() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$2" | JSON_FIELD_KEY="$1" "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let value;
  try {
    value = (JSON.parse(data) || {})[process.env.JSON_FIELD_KEY];
  } catch {
    value = undefined;
  }
  if (typeof value === "string") process.stdout.write(value + "\n");
});
' 2>/dev/null
}

# Prints a top-level JSON value of any type (not just strings) from the
# document passed as $2, verbatim. json_field above refuses non-string values,
# so this exists to hand the ContentPart array under `prompt` to prompt_text.
json_raw() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$2" | JSON_FIELD_KEY="$1" "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let value;
  try {
    value = (JSON.parse(data) || {})[process.env.JSON_FIELD_KEY];
  } catch {
    value = undefined;
  }
  if (value !== undefined && value !== null) process.stdout.write(JSON.stringify(value) + "\n");
});
' 2>/dev/null
}

# Kimi hands `UserPromptSubmit` a ContentPart array (`prompt`) rather than a
# plain string; joins the text parts so chat bubbles and derived session names
# show what the user actually typed.
prompt_text() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let value;
  try {
    value = JSON.parse(data || "\"\"");
  } catch {
    value = "";
  }
  if (typeof value === "string") {
    process.stdout.write(value + "\n");
    return;
  }
  if (!Array.isArray(value)) return;
  const parts = [];
  for (const part of value) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  process.stdout.write(parts.join("") + "\n");
});
' 2>/dev/null
}

# Prints a tab-title-sized session name derived from the prompt's first line.
# Silent no-op without node (the session simply stays unnamed).
session_name_from_prompt() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const lines = data.trim().split(/\r?\n/);
  const line = (lines[0] || "").trim();
  const out = line.length <= 48 ? line : line.slice(0, 47).replace(/\s+$/, "") + "\u2026";
  process.stdout.write(out + "\n");
});
' 2>/dev/null
}

# Kimi exposes no conversation title to hooks, so the session is named after
# its first real user prompt; switching sessions renames on that session's
# first prompt. Pragma preserves manual tab renames regardless.
report_session_name() {
  prompt_text_value="$1"
  [ -n "$hook_session_id" ] || return 0
  [ "$(cat "$named_file" 2>/dev/null)" = "$hook_session_id" ] && return 0
  session_name="$(session_name_from_prompt "$prompt_text_value")"
  [ -n "$session_name" ] || return 0
  report session-name --name "$session_name"
  printf '%s' "$hook_session_id" >"$named_file"
}

# Reports a rich message whose text is JSON-escaped (safe for arbitrary
# content). Silent no-op without node or when the text is empty.
content_message() {
  role="$1"
  text="$2"
  [ -n "$node_bin" ] && [ -n "$text" ] || return 0
  id="${agent}-${tab}-$(date +%s)-$$-$role"
  ts="$(message_ts_ms)"
  active="$(tracked_subagent_count)"
  payload=$(MSG_ID="$id" MSG_ROLE="$role" MSG_TEXT="$text" MSG_TS="$ts" MSG_ACTIVE="$active" "$node_bin" -e '
process.stdout.write(JSON.stringify({
  id: process.env.MSG_ID,
  role: process.env.MSG_ROLE,
  text: process.env.MSG_TEXT,
  subAgentsActive: Number(process.env.MSG_ACTIVE),
  ts: Number(process.env.MSG_TS),
}));
' 2>/dev/null)
  [ -n "$payload" ] || return 0
  "$pragma_cli" agent message --agent "$agent" --payload "$payload" >/dev/null 2>&1 || true
}

# Prints the newest assistant text part from the session's wire transcript —
# the reply the turn that just stopped produced. Kimi's `Stop` payload carries
# no reply text, so the transcript (written as the turn streams) is the only
# channel for the actual answer. Empty output when unavailable (no node, a
# changed session layout, or a turn that ended without text), letting callers
# fall back to a coarse completion message.
last_assistant_text() {
  session_id="$1"
  [ -n "$node_bin" ] && [ -n "$session_id" ] || return 0
  transcript="$(printf '%s' "$HOME/.kimi-code/sessions"/*/"$session_id"/agents/main/wire.jsonl 2>/dev/null | head -n 1)"
  [ -n "$transcript" ] && [ -f "$transcript" ] || return 0
  MSG_TRANSCRIPT="$transcript" "$node_bin" -e '
let fs = require("fs");
let last = "";
for (const line of fs.readFileSync(process.env.MSG_TRANSCRIPT, "utf8").split("\n")) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    continue;
  }
  if (!value || value.type !== "context.append_loop_event") continue;
  const event = value.event || {};
  if (event.type !== "content.part") continue;
  const part = event.part || {};
  if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
    last = part.text;
  }
}
if (last) process.stdout.write(last);
' 2>/dev/null
}

# Prints the question text from a PreToolUse `AskUserQuestion` payload ($1)
# when it carries exactly one question. Empty for multi-question payloads
# (those fall back to a generic attention + Kimi's native question UI) or
# without node.
question_text() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let toolInput;
  try {
    toolInput = (JSON.parse(data) || {}).tool_input;
  } catch {
    return;
  }
  if (typeof toolInput === "string") {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = {};
    }
  }
  if (!toolInput || typeof toolInput !== "object") return;
  const questions = toolInput.questions;
  if (Array.isArray(questions) && questions.length === 1 && questions[0] && typeof questions[0] === "object") {
    const text = questions[0].question;
    if (typeof text === "string" && text) process.stdout.write(text + "\n");
  }
});
' 2>/dev/null
}

# Prints the first question's options as pragma-cli QuestionOption JSON.
question_options() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const input = (JSON.parse(data) || {}).tool_input || {};
    const question = Array.isArray(input.questions) ? input.questions[0] : null;
    const options = Array.isArray(question?.options)
      ? question.options.flatMap((option) => typeof option?.label === "string" && option.label
          ? [{ label: option.label, ...(typeof option.description === "string" && option.description ? { description: option.description } : {}) }]
          : [])
      : [];
    if (options.length) process.stdout.write(JSON.stringify(options));
  } catch {}
});
' 2>/dev/null
}

# Prints all questions for a multi-question attention, or nothing for one.
question_json() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const input = (JSON.parse(data) || {}).tool_input || {};
    if (input.background === true || !Array.isArray(input.questions) || input.questions.length < 2) return;
    const questions = input.questions.flatMap((question) => {
      if (!question || typeof question.question !== "string" || !question.question) return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => typeof option?.label === "string" && option.label
            ? [{ label: option.label, ...(typeof option.description === "string" && option.description ? { description: option.description } : {}) }]
            : [])
        : [];
      return [{ question: question.question, options }];
    });
    if (questions.length > 1) process.stdout.write(JSON.stringify(questions));
  } catch {}
});
' 2>/dev/null
}

question_is_background() {
  [ -n "$node_bin" ] || return 1
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try { process.exit((JSON.parse(data) || {}).tool_input?.background === true ? 0 : 1); }
  catch { process.exit(1); }
});
' >/dev/null 2>&1
}

# Extracts a human-readable command string from a PermissionRequest stdin JSON
# payload (passed as $1). Prefers the Bash command; falls back to the tool name
# when the tool has no command field, so the approval toast always shows
# *something* to approve.
extract_command() {
  [ -n "$node_bin" ] || return 0
  printf '%s' "$1" | "$node_bin" -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(data) || {};
  } catch {
    return;
  }
  let toolInput = payload.tool_input || {};
  if (typeof toolInput === "string") {
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = {};
    }
  }
  if (!toolInput || typeof toolInput !== "object") toolInput = {};
  const command = toolInput.command;
  if (typeof command === "string" && command) {
    process.stdout.write(command + "\n");
    return;
  }
  const name = payload.tool_name || "tool";
  const path = toolInput.file_path || toolInput.filePath || toolInput.path;
  process.stdout.write((typeof path === "string" && path ? `${name} ${path}` : name) + "\n");
});
' 2>/dev/null
}

# Subagent accounting. Kimi subagents share the parent session id, and parallel
# subagents all carry the default profile name (`coder`), so there is no stable
# per-child id across SubagentStart/SubagentStop to key markers on. The only
# correct primitive is a shared active-child COUNT, mutated under a `mkdir`-based
# exclusive lock so the parallel start/stop hook invocations cannot lose updates
# (POSIX sh has no atomic increment, but POSIX guarantees `mkdir` is atomic, so
# this needs no interpreter at all).
count_file="${state_dir}/pragma-cli-${agent}-${tab}.subagents"
count_lock="${count_file}.lock"

# Mutates the shared subagent count (`inc`/`dec`/`reset`) under the `mkdir` lock
# and prints the new value.
subagent_count() {
  tries=0
  until mkdir "$count_lock" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 200 ] || break
    sleep 0.02
  done
  value=0
  [ -f "$count_file" ] && value="$(cat "$count_file" 2>/dev/null)"
  case "$value" in
    '' | *[!0-9]*) value=0 ;;
  esac
  case "$1" in
    inc) value=$((value + 1)) ;;
    dec)
      if [ "$value" -gt 0 ]; then
        value=$((value - 1))
      else
        value=0
      fi
      ;;
    *) value=0 ;;
  esac
  printf '%s' "$value" >"$count_file"
  rmdir "$count_lock" 2>/dev/null
  printf '%s' "$value"
}

track_subagent() {
  subagent_count inc >/dev/null
}

untrack_subagent() {
  subagent_count dec >/dev/null
}

tracked_subagent_count() {
  count=0
  [ -f "$count_file" ] && count="$(cat "$count_file" 2>/dev/null)"
  case "$count" in
    ''|*[!0-9]*) count=0 ;;
  esac
  printf '%s' "$count"
}

has_tracked_subagents() {
  [ "$(tracked_subagent_count)" -gt 0 ]
}

clear_subagents() {
  subagent_count reset >/dev/null
}

# Clears the in-flight turn marker and every turn-scoped state file. Leaves the
# session pin and the subagent accounting alone (callers decide their fate).
clear_turn() {
  rm -f "$marker" "$turn_session_file"
}

input="$(cat)"
hook_event_name="$(json_field hook_event_name "$input")"
hook_session_id="$(json_field session_id "$input")"

# Subagent lifecycle first: those hooks share the parent session id, so they
# are accounted for explicitly and never fall through to the parent status
# machine below. Parallel subagents all report the default profile name, so the
# count (not a per-name marker) is the discriminator.
if [ "${1:-}" = "subagent-start" ]; then
  track_subagent
  [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
  message system "Kimi started a subagent"
  report started
  exit 0
fi
if [ "${1:-}" = "subagent-stop" ]; then
  untrack_subagent
  exit 0
fi

# Pin this tab to the parent session established by SessionStart /
# UserPromptSubmit and reject every event from a different session before it can
# alter parent status.
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
    # running, and surface the prompt as the chat's user bubble (Kimi's prompt
    # is a ContentPart array, so the text parts must be joined first).
    token="$$-$(date +%s)"
    printf '%s' "$token" >"$marker"
    printf '%s' "$hook_session_id" >"$turn_session_file"
    report started
    prompt="$(prompt_text "$(json_raw prompt "$input")")"
    if [ -n "$prompt" ]; then
      content_message user "$prompt"
    else
      message assistant "Kimi turn started"
    fi
    report_session_name "$prompt"
    ;;
  stopped)
    # Stop fires only for genuine completions. A Stop arriving while a subagent
    # is still tracked is that subagent's own turn ending (kimi subagents share
    # the parent session id) -- the session keeps working, so stay on `started`.
    if has_tracked_subagents; then
      [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
      report started
      message assistant "Kimi is waiting on subagents"
      exit 0
    fi
    if [ ! -f "$marker" ]; then
      # No turn was ever started for this tab: a bare Stop must not create a
      # phantom done dot.
      exit 0
    fi
    clear_turn
    report stopped
    reply_session_id="${hook_session_id:-$(cat "$session_file" 2>/dev/null)}"
    reply="$(last_assistant_text "$reply_session_id")"
    if [ -n "$reply" ]; then
      content_message assistant "$reply"
    else
      message assistant "Kimi turn completed"
    fi
    ;;
  failed)
    # StopFailure: the turn ended on an API error, so it never completed. Clear
    # rather than report done. A subagent's failure while the parent still works
    # stays on `started` (the Agent tool returns the error to the parent).
    detail="$(json_field error_message "$input")"
    [ -n "$detail" ] || detail="$(json_field errorMessage "$input")"
    [ -n "$detail" ] || detail="unknown error"
    if has_tracked_subagents; then
      [ -f "$marker" ] || printf '%s' "$$-$(date +%s)" >"$marker"
      report started
      message system "Kimi subagent failed ($detail)"
      exit 0
    fi
    if [ -f "$marker" ]; then
      clear_turn
      report cleared
      message system "Kimi turn failed ($detail)"
    fi
    ;;
  interrupted)
    # Interrupt: the user cancelled the running turn (Esc / Ctrl+C). Stop never
    # fires for a cancel, so this is the whole cancel signal -- no watcher.
    if [ -f "$marker" ]; then
      clear_turn
      report cleared
      message system "Kimi turn interrupted"
    fi
    ;;
  cleared)
    # SessionStart fires for a brand new session while the previous one's
    # SessionEnd and the new session's first prompt can race. Skip the clear when
    # the in-flight turn already belongs to this same session.
    if [ "$hook_event_name" = "SessionStart" ] && [ -f "$marker" ] &&
      [ -n "$hook_session_id" ] &&
      [ "$(cat "$turn_session_file" 2>/dev/null)" = "$hook_session_id" ]; then
      exit 0
    fi
    clear_turn
    clear_subagents
    if [ "$hook_event_name" = "SessionEnd" ]; then
      rm -f "$session_file" "$named_file"
    fi
    report cleared
    ;;
  running)
    # PostToolUse / PostToolUseFailure: a tool just finished mid-turn. Re-assert
    # `running` so a lingering `attention` (raised for a question or approval
    # Kimi answered in its own TUI) drops back to "in progress" at once instead
    # of staying stuck until Stop. The marker is deliberately left untouched:
    # this is the same turn `started` set up.
    if [ -f "$marker" ]; then
      report started
      # PostToolUse is the only hook that carries content: kimi's `Stop` has no
      # reply text, so the tool result (`tool_output`, capped at 2000 chars by
      # kimi) is the one channel for surfacing what the turn produced. Report it
      # as an assistant message so the conversation shows the result and the
      # verify harness can match on it (e.g. command-no-permission's timestamp).
      tool_output="$(json_field tool_output "$input")"
      if [ -n "$tool_output" ]; then
        content_message assistant "$tool_output"
      else
        message tool "Kimi tool finished"
      fi
    fi
    ;;
  permission)
    # PermissionRequest: Kimi is asking to approve a tool in its own TUI. The
    # hook is fire-and-forget (the verdict comes from the TUI's requestApproval
    # RPC, never from this hook), so this raises a command attention for the
    # user to look at the terminal; PostToolUse clears it once the turn resumes.
    # The attention must carry a request-id (stream-integrity requires command
    # attention to include command/requestId); it is a correlation token, not a
    # brokered verdict, because Kimi answers in its own TUI.
    if [ -f "$marker" ]; then
      command_text="$(extract_command "$input")"
      [ -n "$command_text" ] || command_text="Kimi needs approval"
      request_id="${agent}-${tab}-$(date +%s)-$$"
      report attention --kind command --command "$command_text" --request-id "$request_id"
      message system "Kimi needs approval"
    fi
    ;;
  question)
    # PreToolUse on `AskUserQuestion`: Kimi's TUI owns the answer UI (the hook
    # is veto-only and cannot return an answer), so this raises a question
    # attention for the user to look at the terminal. Like command attention it
    # must carry both a question text and a request-id for stream-integrity.
    if [ -f "$marker" ]; then
      question_is_background "$input" && exit 0
      qtext="$(question_text "$input")"
      qopts="$(question_options "$input")"
      qjson="$(question_json "$input")"
      request_id="${agent}-${tab}-$(date +%s)-$$"
      if [ -n "$qjson" ]; then
        report attention --kind question --questions "$qjson" --request-id "$request_id"
        message system "Kimi is asking questions"
      elif [ -n "$qtext" ] && [ -n "$qopts" ]; then
        report attention --kind question --question "$qtext" --options "$qopts" --request-id "$request_id"
        content_message system "$qtext"
      elif [ -n "$qtext" ]; then
        report attention --kind question --question "$qtext" --request-id "$request_id"
        content_message system "$qtext"
      else
        report attention --kind question --question "Kimi is asking a question" --request-id "$request_id"
        message system "Kimi is asking a question"
      fi
    fi
    ;;
esac

exit 0
