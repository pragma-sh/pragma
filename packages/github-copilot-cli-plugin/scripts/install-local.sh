#!/usr/bin/env sh

set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

command -v copilot >/dev/null 2>&1 || {
  printf '%s\n' "GitHub Copilot CLI is not installed." >&2
  exit 1
}

copilot plugin install "$package_dir"
