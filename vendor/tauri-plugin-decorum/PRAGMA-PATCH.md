# Vendored tauri-plugin-decorum 1.1.1

Pragma patches one bug: `traffic::position_traffic_lights` dereferences the
window's standard buttons unconditionally. The plugin's global
`on_window_ready` hook runs it for every window, so opening any borderless
window (`decorations(false)`) aborts the app with
`cocoa … null reference produced`. Pragma's computer-use cursor overlay is
borderless. The fix is the nil guard marked `PRAGMA PATCH` in
`src/traffic.rs`; nothing else differs from the crates.io 1.1.1 release
except removed non-Rust files (the JS guest bindings, which Pragma does not
use).

Drop this directory and the `[patch.crates-io]` entry in the root
`Cargo.toml` once an upstream release guards the null buttons.
