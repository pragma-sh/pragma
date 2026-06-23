#!/usr/bin/env bash
set -euo pipefail

# Build the detached PTY daemon (`pragma-daemon`) and agent reporter
# (`pragma-agent`), then stage sidecars/resources so the bundle is self-contained. The release app launches the daemon
# from beside its own executable (see `daemon_executable()` in
# `src-tauri/src/pty.rs`), and the Tauri CLI only copies it there if a
# `pragma-daemon-<target-triple>` binary exists under `src-tauri/binaries/`;
# the app installs `pragma-agent` from its sibling sidecar on startup.
#
# Pass `--release` for production builds (`tauri build`). The default debug
# build keeps `tauri dev` fast: dev runs the daemon via `cargo run`, so the
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
  cargo build -p pragma-daemon --release
  cargo build -p pragma-agent-cli --release
else
  cargo build -p pragma-daemon
  cargo build -p pragma-agent-cli
fi

# Build the opencode plugin dist so it can be staged as a resource and
# installed into the user's opencode config on app startup.
bun --filter @pragma/opencode-plugin build

# Build the `pragma-ai` sidecar (a Bun-compiled standalone that runs the
# Node-only pi coding-agent SDK out of process for the AI features). A debug app
# runs it from source via `bun`, but the binary must still exist so the Tauri
# CLI's externalBin copy step succeeds.
bun --filter @pragma/ai-helpers build:sidecar

mkdir -p "$src_tauri_dir/binaries"
cp "$repo_root/target/$profile/pragma-daemon" \
  "$src_tauri_dir/binaries/pragma-daemon-$triple"
cp "$repo_root/target/$profile/pragma-agent" \
  "$src_tauri_dir/binaries/pragma-agent-$triple"
cp "$repo_root/packages/ai-helpers/dist/pragma-ai" \
  "$src_tauri_dir/binaries/pragma-ai-$triple"

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

echo "staged pragma-daemon ($profile) -> src-tauri/binaries/pragma-daemon-$triple"
echo "staged pragma-agent ($profile) -> src-tauri/binaries/pragma-agent-$triple"
echo "staged pragma-ai -> src-tauri/binaries/pragma-ai-$triple"
echo "staged bundled agent configs -> src-tauri/resources/pragma/agents"
