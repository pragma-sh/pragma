#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_tauri_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$src_tauri_dir/../../.." && pwd)"

# Pre-push and Tauri dev can stage concurrently. Serialize the full build/copy
# transaction so one process cannot remove resources/plugins during another's cp.
lock_file="$src_tauri_dir/resources/.stage-bundled-plugins.lock"
while true; do
  if (set -o noclobber; printf '%s\n' "$$" > "$lock_file") 2>/dev/null; then
    break
  fi

  lock_pid=""
  read -r lock_pid < "$lock_file" 2>/dev/null || true
  if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f "$lock_file"
    continue
  fi
  sleep 0.1
done

release_lock() {
  lock_pid=""
  read -r lock_pid < "$lock_file" 2>/dev/null || true
  if [[ "$lock_pid" == "$$" ]]; then
    rm -f "$lock_file"
  fi
}
trap release_lock EXIT INT TERM

bunx turbo run build --filter=@pragma-sh/claude-code-plugin --filter=@pragma-sh/opencode-plugin --filter=@pragma-sh/cursor-plugin --filter=@pragma-sh/github-copilot-cli-plugin

plugins_dir_name="$(bun -e 'import { constants } from "@pragma/constants"; process.stdout.write(constants.plugins.bundledDirName)')"
bundled_plugins_dir="$src_tauri_dir/resources/$plugins_dir_name"
rm -rf "$bundled_plugins_dir"

for plugin_spec in \
  "claude-code:claude-code-plugin" \
  "opencode:opencode-plugin" \
  "cursor:cursor-plugin" \
  "github-copilot:github-copilot-cli-plugin"; do
  target_name="${plugin_spec%%:*}"
  package_name="${plugin_spec#*:}"
  source_dir="$repo_root/packages/$package_name"
  target_dir="$bundled_plugins_dir/$target_name"
  mkdir -p "$target_dir"
  cp "$source_dir/package.json" "$target_dir/package.json"
  cp -R "$source_dir/dist" "$target_dir/dist"
  cp -R "$source_dir/assets" "$target_dir/assets"

  # The desktop webview imports each `pragma.main` bundle through a blob URL to
  # list launchable agents. A *static* `node:` import fails to resolve there, so
  # the plugin loads as `failed` and its agents vanish from the launcher while
  # the Bun sidecars keep working — a split-brain failure the catalog hides.
  # Keep node-only code behind a lazy `await import(...)`.
  main="$(bun -e 'const pkg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(pkg.pragma?.main ?? pkg.main ?? "")' "$target_dir/package.json")"
  if [[ -n "$main" ]] && grep -Eq '(^|[[:space:]])from[[:space:]]*"node:' "$target_dir/$main"; then
    echo "error: $package_name's plugin entry ($main) has a static node: import; the webview cannot load it" >&2
    exit 1
  fi
done

echo "staged bundled plugins -> src-tauri/resources/$plugins_dir_name"
