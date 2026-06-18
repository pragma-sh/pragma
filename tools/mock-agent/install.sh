#!/usr/bin/env bash
set -euo pipefail

agent_dir="$HOME/.pragma/agents/mock"
mkdir -p "$agent_dir"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$script_dir/mock-agent.sh" "$agent_dir/mock-agent.sh"
cp "$script_dir/mock-agent-delayed-navigation.sh" "$agent_dir/mock-agent-delayed-navigation.sh"
chmod +x "$agent_dir/mock-agent.sh"
chmod +x "$agent_dir/mock-agent-delayed-navigation.sh"

python3 - <<'PY' "$agent_dir/icon.png"
import base64
import pathlib
import sys

png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGNgGAXDUBz6z0AEYBxVSFUwCkbBqBgFAAKiAhH5GfNqAAAAAElFTkSuQmCC"
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(png))
PY

cat > "$agent_dir/config.json" <<JSON
{
  "id": "mock",
  "name": "Mock Agent",
  "icon": "icon.png",
  "start": "$agent_dir/mock-agent.sh"
}
JSON

printf 'Installed mock agent at %s\n' "$agent_dir"
