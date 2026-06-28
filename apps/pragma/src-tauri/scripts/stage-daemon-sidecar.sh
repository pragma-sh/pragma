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
  cargo build -p pragma-cli --release
else
  cargo build -p pragma-server
  cargo build -p pragma-cli
fi

# Build the opencode plugin dist so it can be staged as a resource and
# installed into the user's opencode config on app startup.
bun --filter @pragma/opencode-plugin build

# Build the `pragma-ai` sidecar (a Bun-compiled standalone that runs the
# Node-only pi coding-agent SDK out of process for the AI features). A debug app
# runs it from source via `bun`, but the binary must still exist so the Tauri
# CLI's externalBin copy step succeeds.
bun --filter @pragma/ai-helpers build:sidecar
bun --filter @pragma/github-helpers build:sidecar

mkdir -p "$src_tauri_dir/binaries"
cp "$repo_root/target/$profile/pragma-server" \
  "$src_tauri_dir/binaries/pragma-server-$triple"
cp "$repo_root/target/$profile/pragma-cli" \
  "$src_tauri_dir/binaries/pragma-cli-$triple"
cp "$repo_root/packages/ai-helpers/dist/pragma-ai" \
  "$src_tauri_dir/binaries/pragma-ai-$triple"
cp "$repo_root/packages/github-helpers/dist/pragma-github" \
  "$src_tauri_dir/binaries/pragma-github-$triple"

# Remove any plugin JS left over from a previous staging layout. Pragma no longer
# bundles plugin dist (opencode's .mjs) as a Tauri resource; since tauri.conf.json
# bundles `resources/**/*`, a stale `resources/pragma/plugins/` would still get
# bundled, so delete it here.
rm -rf "$src_tauri_dir/resources/pragma/plugins"

# Stage the bundled agent launcher configs (config.json + icon) for every plugin
# package. These are installed into ~/.pragma/agents by `agents::ensure_bundled_installed`
# so the agents appear in the launcher. Plugins themselves (opencode's .mjs, Claude
# Code's hooks.json) are installed into each tool's own config separately, not by Pragma.
rm -rf "$src_tauri_dir/resources/pragma/agents"
mkdir -p "$src_tauri_dir/resources/pragma/agents"
cp -R "$repo_root/packages/opencode-plugin/pragma/agents/." \
  "$src_tauri_dir/resources/pragma/agents"
cp -R "$repo_root/packages/claude-code-plugin/pragma/agents/." \
  "$src_tauri_dir/resources/pragma/agents"
cp -R "$repo_root/packages/cursor-plugin/pragma/agents/." \
  "$src_tauri_dir/resources/pragma/agents"

echo "staged pragma-server ($profile) -> src-tauri/binaries/pragma-server-$triple"
echo "staged pragma-cli ($profile) -> src-tauri/binaries/pragma-cli-$triple"
echo "staged pragma-ai -> src-tauri/binaries/pragma-ai-$triple"
echo "staged pragma-github -> src-tauri/binaries/pragma-github-$triple"
echo "staged bundled agent configs -> src-tauri/resources/pragma/agents"
