# packages/prime-agent-plugin — @pragma/prime-agent-plugin

Prime Agent integration built from `@pragma/pi-plugin` factories. Prime Agent is a
Pi-derived CLI with the same extension lifecycle surface; do not copy or symlink Pi
reporter/watcher code into this package.

## Build and install

```sh
bun run --filter @pragma/pi-plugin build
bun run --filter @pragma/prime-agent-plugin build
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

## Branding

`assets/prime-butterfly.svg` comes from Prime Intellect's official Prime Agent repository:
`https://github.com/PrimeIntellect-ai/prime-agent/blob/main/assets/brand/prime-butterfly.svg`,
retrieved 2026-08-08. Repository and asset are MIT licensed. Geometry and white fill are
preserved; no scripts, event handlers, remote references, or raster data are present.
