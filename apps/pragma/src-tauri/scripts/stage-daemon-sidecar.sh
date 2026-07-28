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
#
# Runs on macOS, Linux, and Windows (under Git Bash, which is what the
# `windows-latest` CI runner provides). On Windows every produced binary carries
# a `.exe` suffix, and Tauri expects the staged name to carry it too —
# `pragma-server-x86_64-pc-windows-msvc.exe`.

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

# Executable suffix for this host. Everything below appends it to both the
# source and staged names rather than assuming an extensionless binary.
exe=""
if [[ "$triple" == *windows* ]]; then
  exe=".exe"
fi

# Rust sidecars, built from this workspace.
rust_sidecars=(pragma-server pragma-gateway pragma-cli)

# `set -u` makes an empty array expansion an error on the bash 3.2 that ships
# with macOS, so the profile flag is passed as a plain (possibly empty) word.
cargo_profile_flag=""
if [[ "$profile" == "release" ]]; then
  cargo_profile_flag="--release"
fi
for crate in "${rust_sidecars[@]}"; do
  # shellcheck disable=SC2086 # intentionally unquoted: empty means "no flag"
  cargo build -p "$crate" $cargo_profile_flag
done

# Bun-compiled sidecars: `<workspace filter>:<package dir>:<binary name>`.
# A debug app runs several of these from source via `bun`, but the binary must
# still exist so the Tauri CLI's externalBin copy step succeeds.
bun_sidecars=(
  "@pragma/ai-helpers:ai-helpers:pragma-ai"
  "@pragma/github-helpers:github-helpers:pragma-github"
  "@pragma/watcher:watcher:pragma-watch"
  "@pragma/automations:automations:pragma-automations"
  # The plugin catalog sidecar statically bundles the built-in agent
  # definitions from the claude-code/opencode/cursor plugin packages.
  "@pragma/plugins-host:plugins-host:pragma-plugins"
)

bun --filter @pragma/ai-helpers build:sidecar
bun --filter @pragma/github-helpers build:sidecar
bun --filter @pragma/watcher build:sidecar
bash "$script_dir/stage-bundled-plugins.sh"
bun --filter @pragma/automations build:sidecar
bun --filter @pragma/plugins-host build:sidecar

mkdir -p "$src_tauri_dir/binaries"

stage() {
  local source="$1"
  local name="$2"
  if [[ ! -f "$source" ]]; then
    echo "stage-daemon-sidecar: missing $source" >&2
    exit 1
  fi
  cp "$source" "$src_tauri_dir/binaries/$name-$triple$exe"
  echo "staged $name -> src-tauri/binaries/$name-$triple$exe"
}

for crate in "${rust_sidecars[@]}"; do
  stage "$repo_root/target/$profile/$crate$exe" "$crate"
done

for entry in "${bun_sidecars[@]}"; do
  IFS=':' read -r _filter package binary <<<"$entry"
  stage "$repo_root/packages/$package/dist/$binary$exe" "$binary"
done

rm -rf "$src_tauri_dir/resources/pragma/agents"
