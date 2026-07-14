#!/usr/bin/env bash
set -euo pipefail

# Build the persistent server (`pragma-server`) and CLI helper
# (`pragma-cli`), then stage sidecars/resources so the bundle is self-contained. The release app launches the server
# from beside its own executable (see `sidecar_executable()` in
# `src-tauri/src/pty.rs`), and the Tauri CLI only copies it there if a
# `pragma-server-<target-triple>` binary exists under `src-tauri/binaries/`;
# the app installs `pragma-cli` from its sibling sidecar on startup.
#
# Pass `--release` for production builds (`tauri build`). The default debug
# build keeps `tauri dev` fast: dev runs the server via `cargo run`, so the
# staged binary merely satisfies the sidecar copy step the CLI performs for
# every `externalBin`.

profile="debug"
if [[ "${1:-}" == "--release" ]]; then
  profile="release"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_tauri_dir="$(cd "$script_dir/.." && pwd)"      # apps/pragma/src-tauri
repo_root="$(cd "$src_tauri_dir/../../.." && pwd)" # workspace root

triple="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$triple" ]]; then
  echo "stage-daemon-sidecar: could not determine host target triple" >&2
  exit 1
fi

if [[ "$profile" == "release" ]]; then
  cargo build -p pragma-server --release
  cargo build -p pragma-gateway --release
  cargo build -p pragma-cli --release
else
  cargo build -p pragma-server
  cargo build -p pragma-gateway
  cargo build -p pragma-cli
fi

# Build the `pragma-ai` sidecar (a Bun-compiled standalone that runs the
# Node-only pi coding-agent SDK out of process for the AI features). A debug app
# runs it from source via `bun`, but the binary must still exist so the Tauri
# CLI's externalBin copy step succeeds.
bun --filter @pragma/ai-helpers build:sidecar
bun --filter @pragma/github-helpers build:sidecar
bun --filter @pragma/watcher build:sidecar
bash "$script_dir/stage-bundled-plugins.sh"
bun --filter @pragma/automations build:sidecar
# Build the plugin catalog sidecar; it statically bundles the built-in agent
# definitions from the claude-code/opencode/cursor plugin packages.
bun --filter @pragma/plugins-host build:sidecar

mkdir -p "$src_tauri_dir/binaries"
cp "$repo_root/target/$profile/pragma-server" \
  "$src_tauri_dir/binaries/pragma-server-$triple"
cp "$repo_root/target/$profile/pragma-gateway" \
  "$src_tauri_dir/binaries/pragma-gateway-$triple"
cp "$repo_root/target/$profile/pragma-cli" \
  "$src_tauri_dir/binaries/pragma-cli-$triple"
cp "$repo_root/packages/ai-helpers/dist/pragma-ai" \
  "$src_tauri_dir/binaries/pragma-ai-$triple"
cp "$repo_root/packages/github-helpers/dist/pragma-github" \
  "$src_tauri_dir/binaries/pragma-github-$triple"
cp "$repo_root/packages/watcher/dist/pragma-watch" \
  "$src_tauri_dir/binaries/pragma-watch-$triple"
cp "$repo_root/packages/automations/dist/pragma-automations" \
  "$src_tauri_dir/binaries/pragma-automations-$triple"
cp "$repo_root/packages/plugins-host/dist/pragma-plugins" \
  "$src_tauri_dir/binaries/pragma-plugins-$triple"

rm -rf "$src_tauri_dir/resources/pragma/agents"

echo "staged pragma-server ($profile) -> src-tauri/binaries/pragma-server-$triple"
echo "staged pragma-gateway ($profile) -> src-tauri/binaries/pragma-gateway-$triple"
echo "staged pragma-cli ($profile) -> src-tauri/binaries/pragma-cli-$triple"
echo "staged pragma-ai -> src-tauri/binaries/pragma-ai-$triple"
echo "staged pragma-github -> src-tauri/binaries/pragma-github-$triple"
echo "staged pragma-watch -> src-tauri/binaries/pragma-watch-$triple"
echo "staged pragma-automations -> src-tauri/binaries/pragma-automations-$triple"
echo "staged pragma-plugins -> src-tauri/binaries/pragma-plugins-$triple"
