#!/usr/bin/env sh
# Install @pragma/cursor-plugin for local use:
# - Copies hooks into ~/.pragma/agents/cursor/
# - Merges Pragma hook entries into ~/.cursor/hooks.json
# - Merges Run Everything defaults into ~/.cursor/cli-config.json and
#   ~/.cursor/permissions.json (IDE + CLI share permissions.json since 2026-03)
# - Optionally merges project overrides into <git-root>/.cursor/permissions.json
#   and permission allowlists into <git-root>/.cursor/cli.json (permissions only)

set -eu

ROOT="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${PRAGMA_CURSOR_AGENT_DIR:-$HOME/.pragma/agents/cursor}"
HOOKS_DIR="$AGENT_DIR/hooks"
REPORT_SH="$HOOKS_DIR/report.sh"
CURSOR_DIR="$HOME/.cursor"
CURSOR_HOOKS="$CURSOR_DIR/hooks.json"
CURSOR_CLI_CONFIG="$CURSOR_DIR/cli-config.json"
CURSOR_PERMISSIONS="$CURSOR_DIR/permissions.json"
LEGACY_LAUNCHER="$HOME/.local/bin/pragma-cursor-agent"
GIT_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"

fail() {
  echo "install-local: $1" >&2
  exit 1
}

require_write() {
  target="$1"
  dir="$(dirname "$target")"
  if ! mkdir -p "$dir" 2>/dev/null; then
    fail "cannot create $dir (run outside the sandbox: bun run --filter @pragma/cursor-plugin install:local)"
  fi
  if [ -e "$target" ] && [ ! -w "$target" ]; then
    fail "cannot write $target (run outside the sandbox: bun run --filter @pragma/cursor-plugin install:local)"
  fi
  probe="$dir/.pragma-cursor-install-probe"
  if ! touch "$probe" 2>/dev/null; then
    fail "cannot write under $dir (run outside the sandbox: bun run --filter @pragma/cursor-plugin install:local)"
  fi
  rm -f "$probe"
}

require_write "$REPORT_SH"
require_write "$CURSOR_HOOKS"
require_write "$CURSOR_CLI_CONFIG"
require_write "$CURSOR_PERMISSIONS"

cp "$ROOT/hooks/report.sh" "$REPORT_SH" || fail "failed to copy report.sh to $REPORT_SH"
cp "$ROOT/pragma/agents/cursor/config.json" "$AGENT_DIR/config.json" || fail "failed to copy config.json"
cp "$ROOT/pragma/agents/cursor/icon.svg" "$AGENT_DIR/icon.svg" || fail "failed to copy icon.svg"
chmod +x "$REPORT_SH"

rm -f "$AGENT_DIR/launch.expect" "$AGENT_DIR/pragma-cursor-agent.sh" 2>/dev/null || true
if [ -f "$LEGACY_LAUNCHER" ]; then
  rm -f "$LEGACY_LAUNCHER"
fi

export ROOT AGENT_DIR REPORT_SH CURSOR_HOOKS CURSOR_CLI_CONFIG CURSOR_PERMISSIONS GIT_ROOT
export REPORT_CMD="sh \"$REPORT_SH\""
python3 <<'PY'
import json
import os


def load_json(path: str) -> dict:
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            raw = f.read().strip()
            if raw:
                return json.loads(raw)
    return {}


def save_json(path: str, data: dict) -> None:
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def merge_unique_strings(existing: list[str], additions: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in additions + existing:
        if value not in seen:
            seen.add(value)
            merged.append(value)
    return merged


def merge_permissions_file(target_path: str, label: str) -> None:
    fragment_path = os.path.join(os.environ["ROOT"], "hooks", "permissions.fragment.json")
    with open(fragment_path, encoding="utf-8") as f:
        fragment = json.load(f)

    existing = load_json(target_path)
    existing["approvalMode"] = fragment["approvalMode"]
    existing["mcpAllowlist"] = merge_unique_strings(
        existing.get("mcpAllowlist", []),
        fragment.get("mcpAllowlist", []),
    )
    existing["terminalAllowlist"] = merge_unique_strings(
        existing.get("terminalAllowlist", []),
        fragment.get("terminalAllowlist", []),
    )

    save_json(target_path, existing)
    print(f"Updated {label} -> {target_path}")


def merge_cli_config(target_path: str, label: str) -> None:
    """Global ~/.cursor/cli-config.json — full schema."""
    fragment_path = os.path.join(os.environ["ROOT"], "hooks", "cli.fragment.json")
    with open(fragment_path, encoding="utf-8") as f:
        fragment = json.load(f)

    existing = load_json(target_path)
    existing.setdefault("version", 1)
    existing["showSandboxIntro"] = fragment["showSandboxIntro"]
    existing["approvalMode"] = fragment["approvalMode"]

    sandbox = existing.setdefault("sandbox", {})
    if not isinstance(sandbox, dict):
        sandbox = {}
        existing["sandbox"] = sandbox
    sandbox.update(fragment.get("sandbox", {}))

    _merge_permissions_block(existing, fragment.get("permissions", {}))

    save_json(target_path, existing)
    print(f"Updated {label} -> {target_path}")


def _merge_permissions_block(existing: dict, fragment_permissions: dict) -> None:
    permissions = existing.setdefault("permissions", {})
    if not isinstance(permissions, dict):
        permissions = {}
        existing["permissions"] = permissions
    permissions["allow"] = merge_unique_strings(
        permissions.get("allow", []),
        fragment_permissions.get("allow", []),
    )
    permissions["deny"] = merge_unique_strings(
        permissions.get("deny", []),
        fragment_permissions.get("deny", []),
    )


def merge_project_cli(target_path: str, label: str) -> None:
    """Project .cursor/cli.json — permissions only (see Cursor CLI docs)."""
    fragment_path = os.path.join(os.environ["ROOT"], "hooks", "cli.fragment.json")
    with open(fragment_path, encoding="utf-8") as f:
        fragment = json.load(f)

    existing = load_json(target_path)
    # Strip keys that belong in global cli-config.json only.
    for key in ("version", "showSandboxIntro", "approvalMode", "sandbox", "editor", "model"):
        existing.pop(key, None)

    _merge_permissions_block(existing, fragment.get("permissions", {}))

    save_json(target_path, existing)
    print(f"Updated {label} -> {target_path}")


def merge_hooks() -> None:
    report_cmd = os.environ["REPORT_CMD"]
    fragment_path = os.path.join(os.environ["ROOT"], "hooks", "hooks.fragment.json")
    cursor_hooks = os.environ["CURSOR_HOOKS"]

    with open(fragment_path, encoding="utf-8") as f:
        fragment = json.load(f)

    pragma_hooks = {}
    for event, entries in fragment.items():
        merged = []
        for entry in entries:
            cmd = entry["command"].replace("__REPORT_SH__", report_cmd)
            merged_entry: dict[str, str] = {"command": cmd}
            if "matcher" in entry:
                merged_entry["matcher"] = entry["matcher"]
            merged.append(merged_entry)
        pragma_hooks[event] = merged

    existing = load_json(cursor_hooks)
    existing.setdefault("version", 1)
    hooks = existing.setdefault("hooks", {})

    report_sh = os.path.expanduser(os.environ["REPORT_SH"])
    for event, entries in list(hooks.items()):
        kept = [
            e
            for e in entries
            if report_sh not in e.get("command", "")
            and "/cursor-plugin/hooks/report.sh" not in e.get("command", "")
            and ".pragma/agents/cursor/hooks/report.sh" not in e.get("command", "")
        ]
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]

    for event, entries in pragma_hooks.items():
        hooks.setdefault(event, [])
        hooks[event] = [e for e in hooks[event] if report_sh not in e.get("command", "")]
        hooks[event].extend(entries)

    save_json(cursor_hooks, existing)
    print(f"Merged hooks -> {cursor_hooks}")


merge_hooks()
merge_cli_config(os.environ["CURSOR_CLI_CONFIG"], "CLI config")
merge_permissions_file(os.environ["CURSOR_PERMISSIONS"], "user permissions")

git_root = os.environ.get("GIT_ROOT", "")
if git_root:
    project_cursor = os.path.join(git_root, ".cursor")
    merge_permissions_file(
        os.path.join(project_cursor, "permissions.json"),
        "project permissions",
    )
    merge_project_cli(os.path.join(project_cursor, "cli.json"), "project CLI permissions")

agent_dir = os.environ["AGENT_DIR"]
for required in ("config.json", "hooks/report.sh", "icon.svg"):
    path = os.path.join(agent_dir, required)
    if not os.path.isfile(path):
        raise SystemExit(f"install verification failed: missing {path}")

print(f"Installed agent launcher config -> {agent_dir}")
PY

echo ""
echo "Installed:"
echo "  Agent:       $AGENT_DIR"
echo "  Hooks:       $CURSOR_HOOKS"
echo "  CLI config:  $CURSOR_CLI_CONFIG"
echo "  Permissions: $CURSOR_PERMISSIONS"
if [ -n "$GIT_ROOT" ]; then
  echo "  Project:     $GIT_ROOT/.cursor/{cli.json,permissions.json}"
fi
echo ""
echo "Restart Cursor / Pragma if they were open. Launch: agent --force --approve-mcps"
