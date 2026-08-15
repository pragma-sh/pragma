# packages/pi-plugin — @pragma/pi-plugin

Self-contained Pi CLI integration. It builds an in-process Pi extension and a Pragma
catalog/watcher bundle; it must not add Pi-specific installers or parsing to Pragma core.

## Files

- `src/index.ts` — Pi extension entry point using `@pragma/sdk`.
- `src/extension-factory.ts` — reusable lifecycle extension factory for Pi-derived agents.
- `src/reporter.ts` — serialized lifecycle state machine.
- `src/pragma-plugin.ts` — `defineAgent` launcher and interjection watcher.
- `src/pragma-plugin-factory.ts` — reusable branded launcher/model/watcher factory.

Pi-derived products import the two factory subpaths rather than symlinking this package or
re-exporting Pi's upstream API. Product packages own their agent id, command, branding,
feature exclusions, and any provider-specific usage-limit implementation.

Pi-family interjections use Kitty-protocol Alt+Enter (`ESC [13;3u`), not carriage
return: while a turn streams, Enter inserts a newline and Alt+Enter queues the
follow-up. Launch prefills use Kitty Enter (`ESC [13u`). The shared launcher also
clears the composer shortly before prefill because Pi's 100ms OSC 11 theme-query
timeout is shorter than a relayed terminal roundtrip; otherwise the late
`]11;rgb:…` response can remain in the input.

## Lifecycle mapping

| Pi event                                                 | Pragma report                                 |
| -------------------------------------------------------- | --------------------------------------------- |
| extension/session load                                   | `cleared`                                     |
| `agent_start`                                            | `started`                                     |
| normal `agent_end` after a start                         | `stopped`                                     |
| `agent_end` containing assistant `stopReason: "aborted"` | `cleared`                                     |
| `session_shutdown`                                       | `cleared`                                     |
| first `before_agent_start` prompt after each `cleared`   | `session-name` (first prompt line, ~48 chars) |

Pi 0.80.10 emits `agent_end` after Escape abort and records the final assistant message
with `stopReason: "aborted"`; do not report that event as stopped. The integration does
not add tools, permission prompts, or sub-agent support that stock Pi does not provide.
Session-exit clearing uses both layers: extension `session_shutdown` reports `cleared`
on a graceful quit. The exact launched-session watcher also reports `cleared`
when its session exits, covering crashes and kills that skip `session_shutdown`; reporting
failures are swallowed so cleanup cannot disrupt watcher shutdown.

## Build and install

```sh
bun run --filter @pragma/pi-plugin build
pi install /absolute/path/to/packages/pi-plugin
```

Local package installation records the package in Pi's user settings. Rebuild this
package and run `/reload` in Pi after changing the extension bundle.

Model discovery checks `pi` on the plugin-host PATH, FNM's default Node environment,
`$HOME/.bun/bin/pi`, then a login shell. GUI-launched plugin hosts often omit active
Node-manager bins from PATH even when Pi launches normally from an interactive terminal;
keep these explicit fallbacks.

## Verification

Quit the desktop app first so verification uses the fresh headless catalog. Verify only
stock Pi capabilities: `basic-reply`, `abort-mid-run`, `interrupt-event`, `crash-exit`,
and `stream-integrity`. Question, command-approval, and sub-agent scenarios are skipped
through `excludeFeatures` because Pi does not provide those features by default. Usage
limits are excluded too because Pi exposes no account-limit provider.

## Branding

The vendor-controlled Pi press kit (`https://pi.dev/press-kit`) publishes the official
square SVG badge used at `assets/pi-badge.svg`. Original source:
`https://pi.dev/favicon.svg`, retrieved 2026-07-16. The press-kit page identifies the
site and assets as MIT licensed. Preserve original geometry and colors; do not replace
it with a traced or third-party mark.
