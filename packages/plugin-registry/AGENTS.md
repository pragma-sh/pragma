# packages/plugin-registry - official plugin distribution metadata

`official.json` is human-reviewed and contains npm package identities only. Each package
ships public metadata in root `pragma-plugin.json`. `official.lock.json` is generated from
exact npm releases and caches each full manifest plus npm tarball integrity.

Beyond the required `name`/`description`/`install`, a manifest may carry `longDescription`
(extender copy for the website's plugin detail page), `categories`, `images`, and
`agentBinary`. All are optional; consumers must degrade when the lock (or an older
published release) lacks them.

## Publishing and dist-tags

**A plugin release publishes itself.** Each official plugin is its own Release Please
component, and when the release PR merges, the `publish-plugins` job in `release.yml`
dispatches `.github/workflows/plugins.yml` once per released plugin, pinned to its release
tag (`ref` input), under `latest`. It dispatches rather than publishes because npm trusts
`plugins.yml` — not `release.yml` — for these ten packages; moving that trust would need an
`npm trust` change per package. `scripts/release-config.test.ts` fails if a package in
`official.json` is missing from the Release Please config or the workflow's choice list.

**A host-tool manifest that declares a `version` is an `extra-files` entry.** Claude Code and
Codex cache an installed plugin under that version (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, …) and only refresh the cache when it changes, so a manifest
left at a placeholder keeps users on the first release they installed. Each such manifest is
rewritten with `$.version` on release; `scripts/release-config.test.ts` fails if a new one is
missed. Likewise an installer that edits the host's config must replace a previous install
wherever it lived: Pragma deletes superseded `~/.pragma/plugins/npm/<name>-<version>-<uuid>`
directories, so matching only the old absolute path leaves hooks pointing at nothing.

The dist-tag is still an explicit input for a manual run (`latest` by default, or `alpha`).
It matters because `npm publish --tag alpha` does **not** move `latest`. The lock always
resolves `latest` (`PRAGMA_PLUGIN_DIST_TAG` overrides it locally), so an `alpha` publish never
becomes what the desktop installs. The ten `refresh-lock` jobs a release fans out share one
concurrency group: GitHub runs one and keeps only the newest pending, which is the one that
sees every publish.

The desktop never reads a dist-tag. `plugin_distribution.rs` installs an exact
`<package>@<version>` taken from `official.lock.json` and rejects a tarball whose integrity
differs from the lock, so the tag only affects humans running `npm i` and tooling that
resolves `latest`.

The ten official agent plugins are deliberately **not** in Release Please's linked `desktop`
group: nothing bundles them into the app (there is no staged `resources/plugins` any more),
they install from npm at locked exact versions, and each releases on its own schedule. In
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
must not be committed. The supported path is a release: merging the release PR publishes each
changed package through `plugins.yml`, whose `refresh-lock` regenerates the lock from npm;
then merge its PR. That PR is opened with `RELEASE_PLEASE_TOKEN`: the org forbids
`GITHUB_TOKEN` from creating pull requests, and one it opened would run no CI.
