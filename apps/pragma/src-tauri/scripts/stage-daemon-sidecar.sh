#!/usr/bin/env bash
set -euo pipefail

# Build the detached PTY daemon (`pragma-daemon`) and stage it as a Tauri
# sidecar so the bundle is self-contained. The release app launches the daemon
# from beside its own executable (see `daemon_executable()` in
# `src-tauri/src/pty.rs`), and the Tauri CLI only copies it there if a
# `pragma-daemon-<target-triple>` binary exists under `src-tauri/binaries/`.
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
else
  cargo build -p pragma-daemon
fi

mkdir -p "$src_tauri_dir/binaries"
cp "$repo_root/target/$profile/pragma-daemon" \
  "$src_tauri_dir/binaries/pragma-daemon-$triple"

echo "staged pragma-daemon ($profile) -> src-tauri/binaries/pragma-daemon-$triple"
