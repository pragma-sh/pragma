# packages/pi-plugin — @pragma/pi-plugin

Self-contained Pi CLI integration. It builds an in-process Pi extension and a Pragma
catalog/watcher bundle; it must not add Pi-specific installers or parsing to Pragma core.

## Files

- `src/index.ts` — Pi extension entry point using `@pragma/sdk`.
- `src/reporter.ts` — serialized lifecycle state machine.
- `src/pragma-plugin.ts` — `defineAgent` launcher and interjection watcher.

## Lifecycle mapping

| Pi event                                                 | Pragma report |
| -------------------------------------------------------- | ------------- |
| extension/session load                                   | `cleared`     |
| `agent_start`                                            | `started`     |
| normal `agent_end` after a start                         | `stopped`     |
| `agent_end` containing assistant `stopReason: "aborted"` | `cleared`     |
| `session_shutdown`                                       | `cleared`     |

Pi 0.80.10 emits `agent_end` after Escape abort and records the final assistant message
with `stopReason: "aborted"`; do not report that event as stopped. The integration does
not add tools, permission prompts, or sub-agent support that stock Pi does not provide.
Session-exit clearing is owned entirely by the extension: `session_shutdown` reports
`cleared` on a graceful quit, and the up-front `cleared` on the next session load
reconciles a hard process exit that skipped `session_shutdown`. The watcher is
interjection-only and deliberately does **not** report `cleared` in a `finally` — that
delayed, watcher-level `cleared` could land after a quickly-relaunched session's
`started` and stomp it. This mirrors opencode.

## Build and install

```sh
bun run --filter @pragma/pi-plugin build
pi install /absolute/path/to/packages/pi-plugin
```

Local package installation records the package in Pi's user settings. Rebuild this
package and run `/reload` in Pi after changing the extension bundle.

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
