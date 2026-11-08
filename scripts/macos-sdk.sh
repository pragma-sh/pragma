#!/usr/bin/env bash
# Pin and verify the macOS SDK the desktop app links against.
#
# AppKit picks a window's chrome (traffic-light buttons, titlebar, corner radius)
# from the SDK recorded in the binary's LC_BUILD_VERSION, not from the OS it runs
# on. A binary linked against an older SDK keeps the old buttons on macOS 27, so
# the build has to run under Xcode 27 and this script makes that fail loudly
# instead of silently regressing when a runner image changes its default Xcode.
#
#   macos-sdk.sh select <xcode-version>          # e.g. 27.1
#   macos-sdk.sh verify <binary> <min-sdk-major> # e.g. target/release/pragma 27
set -euo pipefail

case "${1:-}" in
  select)
    version="${2:?usage: macos-sdk.sh select <xcode-version>}"
    app="/Applications/Xcode_${version}.app"
    if [ ! -d "$app" ]; then
      printf 'Xcode %s is not installed on this runner (%s missing)\n' "$version" "$app" >&2
      ls -d /Applications/Xcode*.app >&2 || true
      exit 1
    fi
    sudo xcode-select -s "$app/Contents/Developer"
    xcodebuild -version
    printf 'macOS SDK %s\n' "$(xcrun --sdk macosx --show-sdk-version)"
    ;;
  verify)
    binary="${2:?usage: macos-sdk.sh verify <binary> <min-sdk-major>}"
    minimum="${3:?usage: macos-sdk.sh verify <binary> <min-sdk-major>}"
    sdk="$(vtool -show-build "$binary" | awk '$1 == "sdk" { print $2; exit }')"
    if [ -z "$sdk" ]; then
      printf 'No LC_BUILD_VERSION sdk found in %s\n' "$binary" >&2
      exit 1
    fi
    if [ "${sdk%%.*}" -lt "$minimum" ]; then
      printf '%s links macOS SDK %s; need %s+ for the current window chrome\n' "$binary" "$sdk" "$minimum" >&2
      exit 1
    fi
    printf '%s links macOS SDK %s\n' "$binary" "$sdk"
    ;;
  *)
    printf 'usage: macos-sdk.sh select <xcode-version> | verify <binary> <min-sdk-major>\n' >&2
    exit 2
    ;;
esac
