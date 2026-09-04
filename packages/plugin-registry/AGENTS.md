# packages/plugin-registry - official plugin distribution metadata

`official.json` is human-reviewed and contains npm package identities only. Each package
ships public metadata in root `pragma-plugin.json`. `official.lock.json` is generated from
exact npm releases and caches each full manifest plus npm tarball integrity.

Beyond the required `name`/`description`/`install`, a manifest may carry `longDescription`
(extender copy for the website's plugin detail page), `categories`, `images`, and
`agentBinary`. All are optional; consumers must degrade when the lock (or an older
published release) lacks them.

## Commands

```bash
bun run --filter @pragma/plugin-registry lock:local # build + pack workspace packages
bun run --filter @pragma/plugin-registry lock       # resolve published npm releases
bun run --filter @pragma/plugin-registry validate
```

Never hand-edit lock. Gallery and desktop onboarding consume lock, not live package
manifests. Install deep links carry package identity only; app resolves package against
official lock and shows exact cached command before running it.

**Manifest changes ship with the next publish, not with a local re-lock.** The desktop
verifies both the npm tarball integrity _and_ the installed `pragma-plugin.json` hash
against the lock, so committing a lock whose manifest text or integrity does not match the
published release breaks installs of it. `lock:local` packs workspace bytes — its
integrity hashes describe locally-packed tarballs, never the npm releases — so its output
must not be committed. The supported path is the `plugins.yml` workflow: publish each
changed package, let `refresh-lock` regenerate the lock from npm, then merge its PR.
