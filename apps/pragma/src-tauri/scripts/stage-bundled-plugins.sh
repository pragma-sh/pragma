#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_tauri_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$src_tauri_dir/../../.." && pwd)"

bunx turbo run build --filter=@pragma/claude-code-plugin --filter=@pragma/opencode-plugin --filter=@pragma/cursor-plugin --filter=@pragma/github-copilot-cli-plugin

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
done

echo "staged bundled plugins -> src-tauri/resources/$plugins_dir_name"
