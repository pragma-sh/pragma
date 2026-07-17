#!/usr/bin/env sh

set -eu

ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"

command -v codex >/dev/null 2>&1 || {
  echo "install-local: codex is not on PATH" >&2
  exit 1
}

codex plugin marketplace add "$ROOT" --json >/dev/null
codex plugin add pragma-codex@pragma --json >/dev/null

echo "Installed Pragma Codex plugin from $ROOT"
echo "Restart Codex, run /hooks, and trust the Pragma hook definitions."
