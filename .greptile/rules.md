## Monorepo Separation of Concerns

**Goal**: Keep agent-orchestration logic portable and the connector surface swappable.
Flag any code placement that couples core orchestration to a specific agent, or that
puts trust-boundary logic in the wrong tier (client vs. daemon).

### Flag: Connector-specific code inside pragma-core

Built-in agent connectors (config.json + icon, per the connector schema) must stay
data-driven and live outside `pragma-core`. If agent-specific logic — hardcoded argv,
name checks, bespoke status parsing for one agent — shows up in core orchestration
code instead of in a connector definition or the connector-loading layer, flag it.
This breaks the "any CLI agent" contract and defeats user-dir override precedence.

### Flag: Trust-boundary code in src-tauri instead of the daemon

`src-tauri` is the Tauri shell: window management, native OS integration (menu bar,
keychain, vibrancy), and the JS↔Rust IPC bridge. It is not where git, filesystem, PTY,
SQLite, or process-spawning logic belongs — that's the daemon's job, since the daemon
is the single execution backend (and what gets dialed over SSH for remote projects).
If git/fs/PTY/SQLite operations are implemented in src-tauri rather than routed through
the daemon's control-plane protocol, flag it: it reintroduces a local-only assumption
that breaks remote/SSH support and duplicates logic the daemon already owns.

### Not a violation: single-consumer code

Per the promotion principle, don't flag code just because it could theoretically be
shared later. Only flag it if it's coupled to a specific agent/connector, or if it
crosses the client/daemon trust boundary above. Premature extraction isn't the goal —
correct boundary placement is.
