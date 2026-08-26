# packages/plugin-registry - official plugin distribution metadata

`official.json` is human-reviewed and contains npm package identities only. Each package
ships public metadata in root `pragma-plugin.json`. `official.lock.json` is generated from
exact npm releases and caches each full manifest plus npm tarball integrity.

## Commands

```bash
bun run --filter @pragma/plugin-registry lock:local # build + pack workspace packages
bun run --filter @pragma/plugin-registry lock       # resolve published npm releases
bun run --filter @pragma/plugin-registry validate
```

Never hand-edit lock. Gallery and desktop onboarding consume lock, not live package
manifests. Install deep links carry package identity only; app resolves package against
official lock and shows exact cached command before running it.
