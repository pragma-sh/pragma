# packages/plugin-registry - official plugin distribution metadata

`official.json` is human-reviewed and contains npm package identities only. Each package
ships public metadata in root `pragma-plugin.json`. `official.lock.json` is generated from
exact npm releases and caches each full manifest plus npm tarball integrity.

Beyond the required `name`/`description`/`install`, a manifest may carry `longDescription`
(extender copy for the website's plugin detail page), `categories`, `images`, and
`agentBinary`. All are optional; consumers must degrade when the lock (or an older
published release) lacks them.

## Publishing and dist-tags

`.github/workflows/plugins.yml` takes the npm **dist-tag** as an explicit input
(`alpha` by default, or `latest`). It matters because `npm publish --tag alpha` does **not**
move `latest`: publishing a stable release under `alpha` would leave `latest` pinned to
whatever prerelease got there first, which is where these packages sit today
(`latest` = `0.1.0-alpha.0` for all ten). Use `latest` for a stable release, `alpha` for a
prerelease.

The desktop never reads a dist-tag. `plugin_distribution.rs` installs an exact
`<package>@<version>` taken from `official.lock.json` and rejects a tarball whose integrity
differs from the lock, so the tag only affects humans running `npm i` and tooling that
resolves `latest`.

The ten official agent plugins are deliberately **not** in Release Please's linked `desktop`
group: nothing bundles them into the app (there is no staged `resources/plugins` any more),
they install from npm at locked exact versions, and this workflow publishes them by hand. In
the group they would be forced to carry the desktop's version number and would drag a desktop
release out of every plugin change. `@pragma-sh/sdk` and `@pragma-sh/plugin` _are_ in it, because
the `plugins-host` sidecar bundles them.

## Commands

```bash
bun run --filter @pragma-sh/plugin-registry lock:local # build + pack workspace packages
bun run --filter @pragma-sh/plugin-registry lock       # resolve published npm releases
bun run --filter @pragma-sh/plugin-registry validate
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
