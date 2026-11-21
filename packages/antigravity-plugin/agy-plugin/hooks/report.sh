#!/usr/bin/env sh
# Pragma <-> Google Antigravity CLI (agy) status bridge.
#
# hooks.json runs `sh ./hooks/report.sh <HookEvent>` from the installed plugin
# folder for every agy lifecycle event. This wrapper owns exactly two things,
# and leaves everything else to the bundled TypeScript (`dist/hook.mjs`):
#
#   1. Answering agy. agy reads each hook's stdout as its verdict, and an EMPTY
#      PreToolUse answer -- or `{}` -- DENIES the tool call ("tool call denied
#      by pre-tool hook"). The neutral verdict is `ask`, which leaves the
#      decision to agy's own permission policy. The verdict is therefore
#      printed here, first, before anything that could fail, so a missing
#      runtime, a crash, or a timeout can never block the agent.
#   2. The outside-Pragma guard: with no Pragma server socket there is nobody
#      to report to, so nothing else runs.
#
# The TypeScript reporter never writes to stdout; its output is discarded.

set -u

event="${1:-}"

case "$event" in
  PreToolUse) printf '%s\n' '{"decision":"ask"}' ;;
  *) printf '%s\n' '{}' ;;
esac

[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0

hook="$(dirname "$0")/../dist/hook.mjs"
[ -f "$hook" ] || exit 0

# Node is what Pragma's own installer runs with; Bun is the fallback for hosts
# that only have Bun on PATH. Without either the bridge degrades to silence.
runtime="$(command -v node 2>/dev/null || command -v bun 2>/dev/null || true)"
[ -n "$runtime" ] || exit 0

"$runtime" "$hook" "$event" >/dev/null 2>&1 || true
exit 0
