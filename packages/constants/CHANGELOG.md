# Changelog

## [0.2.0](https://github.com/pragma-sh/pragma/compare/constants-v0.1.0...constants-v0.2.0) (2026-09-20)


### Miscellaneous Chores

* **constants:** Synchronize desktop versions

## 0.1.0 (2026-09-20)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* **agents:** improve attention reporting ([c9d77f1](https://github.com/pragma-sh/pragma/commit/c9d77f1446f684bead24ab4779cb0ce4b29aa4ca))
* **agents:** improve attention reporting ([41a3262](https://github.com/pragma-sh/pragma/commit/41a3262c6d0b26c4476528acf7ae7e31fd070f3d))
* **agents:** tag launched tabs with agent identity and wait for alternate screen before prefill ([5c09b1b](https://github.com/pragma-sh/pragma/commit/5c09b1b35756b6c46f84b0f1311ef6b5f2aace29))
* **bench:** reintroduce terminal latency benchmark, fix kill() stderr leak ([25ed749](https://github.com/pragma-sh/pragma/commit/25ed7490f408116437566f5f5af6473785b0ddfd))
* **constants:** add fanout shared types and values ([34ee441](https://github.com/pragma-sh/pragma/commit/34ee4410f3265dcbcf560574b9bd7c06240ac738))
* **constants:** add iconEmoji to the Project type ([a6f02e8](https://github.com/pragma-sh/pragma/commit/a6f02e8b29d82716386dc8780835352e0b938ad0))
* **constants:** add onboarding settings ([24a5462](https://github.com/pragma-sh/pragma/commit/24a546272a45f8d09ac213a04796a82e277db269))
* **constants:** add scratchpad default tab title ([62c9d30](https://github.com/pragma-sh/pragma/commit/62c9d301d812c5222c15f58d382385141b57e68d))
* **constants:** add script migration values ([dfa8d46](https://github.com/pragma-sh/pragma/commit/dfa8d465bd2537be9b6948e5cc8118196ce899a7))
* **constants:** add shared agent alert text and push defaults ([08a6a25](https://github.com/pragma-sh/pragma/commit/08a6a2558d667586f3be832d51cbec2baa8296e2))
* **constants:** add shared alternate-screen timing constants ([cfff85c](https://github.com/pragma-sh/pragma/commit/cfff85c423ff9f2e53bd151183dd21f418d00b0d))
* **constants:** add whiteboard contract and tab kind ([963484a](https://github.com/pragma-sh/pragma/commit/963484a02621dd609d57ed0f8aed8ed34ca3a16d))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* **kanban:** add board draft creation and reasoning ids ([1f2f6b4](https://github.com/pragma-sh/pragma/commit/1f2f6b454d6b549cf0cca7b2d7775bba2ab936f2))
* **pragma-go:** add browser client ([e9942a2](https://github.com/pragma-sh/pragma/commit/e9942a25f5f5104977874fa4464a9d8185119b34))
* **pragma-go:** add browser client ([48aee6b](https://github.com/pragma-sh/pragma/commit/48aee6b6f61048ff4a6c24535360b6ba613dda51))
* **pragma-mobile:** add iOS home-screen widgets ([04a42fe](https://github.com/pragma-sh/pragma/commit/04a42fe3546ec4eaa84a71e84d702a48845855d8))
* **pragma-mobile:** add worktree scratchpads ([3667610](https://github.com/pragma-sh/pragma/commit/36676106e9ae15c483a0c5e3e0968d765138d264))
* **pragma-mobile:** scratchpads on mobile, shared scratchpad contract ([b3aec80](https://github.com/pragma-sh/pragma/commit/b3aec8011c18209b425cdd9b23d7b934137efab7))
* **pragma:** add a "Created with Pragma" footer to pull requests ([99a46bd](https://github.com/pragma-sh/pragma/commit/99a46bdea4ce71ee3de291b76af9fb32b048c6f3))
* **pragma:** add a "Created with Pragma" footer to pull requests ([aaadd29](https://github.com/pragma-sh/pragma/commit/aaadd2915e20bc133f7d1f5927bd624618d772dc))
* **pragma:** add numbered workspace and tab shortcuts ([d2344e0](https://github.com/pragma-sh/pragma/commit/d2344e0fabd6ee20a884b96e7ad4e6c035e823f7))
* **pragma:** add PDF viewer with chunked binary reads via EmbedPDF ([8d914db](https://github.com/pragma-sh/pragma/commit/8d914db5c2db9e5f0809ef0acb109a40856775b9))
* **pragma:** add PDF viewing with EmbedPDF and chunked file reads ([0438237](https://github.com/pragma-sh/pragma/commit/04382379fa2e1918ba62d5450542b47fdf52dfb5))
* **pragma:** first-run onboarding flow ([31d57c2](https://github.com/pragma-sh/pragma/commit/31d57c24d0b33ef468c8a6a760134ba5f5307d12))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** paste dropped files into terminals as host paths ([a09efe0](https://github.com/pragma-sh/pragma/commit/a09efe0e374b76d1ccb36778fc7154419a224fec))
* **pragma:** paste dropped files into terminals as host paths; pace agent launches on PTY connect ([e84fba3](https://github.com/pragma-sh/pragma/commit/e84fba384abd8a0e77f87e06eba4114c9077cc6e))
* **pragma:** pick an emoji project icon ([e1427ee](https://github.com/pragma-sh/pragma/commit/e1427eea48c4ac72287b99d12b9b024d1a7d8c6f))
* **pragma:** polish workspace interactions ([81aed8e](https://github.com/pragma-sh/pragma/commit/81aed8e3cbc0adee9f2c1001a49ed0f8392cc23e))
* **pragma:** polish workspace interactions ([afbb18c](https://github.com/pragma-sh/pragma/commit/afbb18cf70084d79647d00558dae056227d8deab))
* **pragma:** probe WSL distributions from the desktop app ([1542681](https://github.com/pragma-sh/pragma/commit/154268117668914f5c033cf757c163cc1dae9a64))
* **pragma:** upgrade xterm and add cursor-based terminal reconnect ([2e4e0b2](https://github.com/pragma-sh/pragma/commit/2e4e0b2c55c55a80d0376ea0dce8263c784fa8a7))
* push agent alerts to paired phones via Expo ([8f5295b](https://github.com/pragma-sh/pragma/commit/8f5295bfa84a4920f49f8ca0e9e2d2de9215ebb2))
* **release:** add signed desktop updates ([7cccb68](https://github.com/pragma-sh/pragma/commit/7cccb689ebfe930c6dec82513b8d4994e272ead8))
* **release:** publish the integration packages to npm ([96a0c40](https://github.com/pragma-sh/pragma/commit/96a0c4028b3aa1dcfdc7c7137361c215cc6a1a19))
* **scratchpad:** add agent-authored MDX scratchpads ([b34ea0f](https://github.com/pragma-sh/pragma/commit/b34ea0f0629db67fbc976e4543ae74b66d052c94))
* **scratchpad:** add agent-authored MDX scratchpads ([c9ec54d](https://github.com/pragma-sh/pragma/commit/c9ec54dbde08b9514843acdbc07756186972c56d))


### Bug Fixes

* **constants:** create generated output directory ([a8ee4ba](https://github.com/pragma-sh/pragma/commit/a8ee4baeeb5c1fcb45a51ea333d2b9e44d4d447d))
* **constants:** gate mobile pairing on a dedicated gateway API version ([8b60ea3](https://github.com/pragma-sh/pragma/commit/8b60ea38daae7cbd0331ed11bbb4641437c8b33f))
* **gateway:** cover the scratchpad tab kind in default titles ([1cc7fd4](https://github.com/pragma-sh/pragma/commit/1cc7fd4ee164dde672f486e23ba9c645a31d71c0))
* **gateway:** title scratchpad tabs from shared constants ([16f80d4](https://github.com/pragma-sh/pragma/commit/16f80d4d43de4adb95741b28f9e405c35911440c))
* **pragma:** make Settings reachable and deep links single-instance on Linux/Windows ([2ff5cb8](https://github.com/pragma-sh/pragma/commit/2ff5cb820a82f19cdc774f175bb82fa77340ace4))
* **pragma:** make Settings reachable on Linux ([27ee153](https://github.com/pragma-sh/pragma/commit/27ee1532f91cfc97fc1811e609c1c97690ba67da))
* **pragma:** quote drops for cmd.exe and sweep dropped-file temp dirs ([437cdac](https://github.com/pragma-sh/pragma/commit/437cdacba995befa79feb620a8b845b787a51972))
