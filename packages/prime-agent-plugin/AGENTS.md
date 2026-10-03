# packages/prime-agent-plugin — @pragma-sh/prime-agent-plugin

Prime Agent integration built from `@pragma-sh/pi-plugin` factories. Prime Agent is a
Pi-derived CLI with the same extension lifecycle surface; do not copy or symlink Pi
reporter/watcher code into this package.

It also inherits Pi's Kitty Alt+Enter interjection submit and prefill composer
cleanup. Do not replace either with carriage return: during a streaming turn that
adds a newline instead of sending the message.

## Build and install

```sh
bun run --filter @pragma-sh/pi-plugin build
bun run --filter @pragma-sh/prime-agent-plugin build
prime-agent package install /absolute/path/to/packages/prime-agent-plugin
```

Register `dist/pragma-plugin.mjs` through Pragma's `plugins[]` configuration. The local
agent id is `prime-agent`; extension reports, watcher, and launcher must all keep that id.

## Models and verification

Prime Agent replaced Pi's `--list-models` with `prime-agent model list`. The shared
six-column parser remains compatible. Model ids include the configured provider; on the
locally verified Prime Agent 0.7.1 installation, V4 Flash is
`opencode/deepseek-v4-flash`. Do not hard-code that provider as a package default.

Prime Agent currently exposes context-window usage only, not a stable account quota or
reset API. Keep `usageLimits` excluded until upstream publishes a supported endpoint;
do not present context-window consumption as account allowance.

Full live verification is optional while Prime retains Pi's extension API. Focused tests
must still cover identity matching and model parsing.

## Account providers

Uses `piAccountProviders` from `@pragma-sh/pi-plugin/pragma-plugin-factory` with Prime's own store: `PRIME_AGENT_CODING_AGENT_DIR`, default `~/.prime/agent/auth.json` (same entry keys as Pi). The env name is derived from the package's config name upstream (`packages/coding-agent/src/config.ts`). See the Pi guide for why the agent dir never moves. OpenAI switches by swapping `auth.json` like Pi's; its login is `prime-agent --no-session` with `input: ["/login", "ChatGPT"]` and `inputDelayMs: 6000`. Prime 0.7's `/login` takes no provider and lists signed-in providers first, which an in-place sign-in has just signed out of, so the line filters the picker rather than trusting the order; Prime starts a daemon and kernel before its prompt accepts input. Prime cannot sign in against a scratch `PRIME_AGENT_CODING_AGENT_DIR` (its per-user daemon socket is shared and dies with `DaemonSocketClosedError`), which is why sign-in is in place. Prime wraps the sign-in URL at its panel width without an OSC 8 link, so on an SSH host the dialog's link is truncated; Prime opens the browser itself locally.

## Branding

`assets/prime-butterfly.svg` comes from Prime Intellect's official Prime Agent repository:
`https://github.com/PrimeIntellect-ai/prime-agent/blob/main/assets/brand/prime-butterfly.svg`,
retrieved 2026-08-08. Repository and asset are MIT licensed. Geometry and white fill are
preserved; no scripts, event handlers, remote references, or raster data are present.
