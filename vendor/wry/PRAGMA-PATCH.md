# Vendored wry 0.55.1

The macOS webview constructor unconditionally activates NSApplication and makes
the webview first responder, even when its `focused` attribute is false. Creating
Pragma's hidden cursor overlays at the first computer-use session consequently
pulls the user into Pragma.

The two `PRAGMA PATCH` guards in `src/wkwebview/mod.rs` honor `attributes.focused`.
Normal windows retain their default focus behavior; background overlays neither
activate the app nor replace its keyboard responder. The focus API's platform
notes reflect macOS support. The source otherwise matches crates.io 0.55.1;
examples and unrelated release files are omitted.

Remove this directory and the root Cargo patch when upstream supports unfocused
macOS webview creation. Native verification: with another app focused, create the
first cursor overlay (including after enabling computer use mid-run), and confirm
that the foreground app and its keyboard input remain unchanged.
