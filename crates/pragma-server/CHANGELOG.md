# Changelog

## 1.0.0 (2026-09-12)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* **agents:** improve attention reporting ([c9d77f1](https://github.com/pragma-sh/pragma/commit/c9d77f1446f684bead24ab4779cb0ce4b29aa4ca))
* **agents:** improve attention reporting ([41a3262](https://github.com/pragma-sh/pragma/commit/41a3262c6d0b26c4476528acf7ae7e31fd070f3d))
* **agents:** tag launched tabs with agent identity and wait for alternate screen before prefill ([5c09b1b](https://github.com/pragma-sh/pragma/commit/5c09b1b35756b6c46f84b0f1311ef6b5f2aace29))
* **automations:** harden automation discovery ([2ee3df8](https://github.com/pragma-sh/pragma/commit/2ee3df8d99a5aebae21cc06bd30f69dae9e3dcc8))
* **cursor-plugin:** detect question titles and retry usage limits ([dca0014](https://github.com/pragma-sh/pragma/commit/dca00145962a6ecf6e9d86d2d632e02b152c7afc))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* name agent terminal sessions ([90f8f30](https://github.com/pragma-sh/pragma/commit/90f8f30542a8232147adaef2e081bb442e133a5c))
* **platform:** add Windows support via pragma-platform crate ([c291b78](https://github.com/pragma-sh/pragma/commit/c291b7815418a82017dac1cc1753ca0bde059e43))
* **pragma-cli:** support headless concurrent agent verify ([528e8e7](https://github.com/pragma-sh/pragma/commit/528e8e72972c95960ee4961a6fc4bb5f2d01269d))
* **pragma-go:** settings tab, readable agent icons, and desktop-matching session titles ([b0a2729](https://github.com/pragma-sh/pragma/commit/b0a27294d113434040e70a4072ad861bd5f2340d))
* **pragma-mobile:** scratchpads on mobile, shared scratchpad contract ([b3aec80](https://github.com/pragma-sh/pragma/commit/b3aec8011c18209b425cdd9b23d7b934137efab7))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma-server:** supervise a watcher per live agent session ([45dc85d](https://github.com/pragma-sh/pragma/commit/45dc85d6eaaebcc6cb5aabcecefbc411df4dbb66))
* **pragma-server:** tag mirrored tabs with agent identity and use shared timing constants ([5c677ac](https://github.com/pragma-sh/pragma/commit/5c677acfdc03bdef582cf159d8db8be059d5aae7))
* **pragma:** add stacked pull request support ([7345445](https://github.com/pragma-sh/pragma/commit/7345445570f72ae5976ac32da31c521dd2f1680e))
* **pragma:** add stacked pull request support ([405066c](https://github.com/pragma-sh/pragma/commit/405066c093392072f4d10f0113e87877af3c7d13))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** optimistic sidebar row for worktree creation ([0591454](https://github.com/pragma-sh/pragma/commit/059145445b379b994cc86700ddfb613d9e3a700c))
* **pragma:** polish workspace interactions ([81aed8e](https://github.com/pragma-sh/pragma/commit/81aed8e3cbc0adee9f2c1001a49ed0f8392cc23e))
* **pragma:** polish workspace interactions ([afbb18c](https://github.com/pragma-sh/pragma/commit/afbb18cf70084d79647d00558dae056227d8deab))
* **pragma:** show per-commit worktree changes ([e434057](https://github.com/pragma-sh/pragma/commit/e4340570e9a177b3d081b817a8e7bcad23b35533))
* **pragma:** upgrade xterm and add cursor-based terminal reconnect ([2e4e0b2](https://github.com/pragma-sh/pragma/commit/2e4e0b2c55c55a80d0376ea0dce8263c784fa8a7))


### Bug Fixes

* **ci:** clear pre-push quality gate ([6612ea0](https://github.com/pragma-sh/pragma/commit/6612ea025eebc8e160cf6796e3844ac2848163b7))
* **ci:** resolve clippy and format-check failures ([33a24c8](https://github.com/pragma-sh/pragma/commit/33a24c82efe69b7549119117ce7f3ccd72651be4))
* **platform:** plain canonical paths, windowless spawns, macOS-only transparency ([78f003f](https://github.com/pragma-sh/pragma/commit/78f003f0b4b1054b76f4d1cce51f26728f42538f))
* **plugins:** serve agent icons from bytes carried with the catalog ([2fabf3f](https://github.com/pragma-sh/pragma/commit/2fabf3f57090a42ab55f53e2b98a58b616b47883))
* **pragma-server:** detect a Windows shell exit without relying on PTY EOF ([b5c2c46](https://github.com/pragma-sh/pragma/commit/b5c2c46a84078ffeb39837ed327e8389601f5acc))
* **pragma-server:** give the detached-session exit test Windows-CI headroom ([7bc5865](https://github.com/pragma-sh/pragma/commit/7bc5865e5fac8702992276b99ef5aca5b0c75a18))
* **pragma-server:** kill a terminal session's whole process tree, not just the shell ([81ea748](https://github.com/pragma-sh/pragma/commit/81ea748abe823c572b9b7f3b0739a9fb3f34bda0))
* **pragma-server:** resolve runtime watchers for plain terminals ([7c3c033](https://github.com/pragma-sh/pragma/commit/7c3c03384cbb7c87b0b655bcf6cbeef52cfaf044))
* **pragma-server:** spawn tunnel with GUI-safe PATH ([5f79758](https://github.com/pragma-sh/pragma/commit/5f7975800bdf4943275bd613c8adda4eb29f0009))
* **pragma-server:** use PowerShell size query on Windows in resize test ([39f87e6](https://github.com/pragma-sh/pragma/commit/39f87e6579a44dbf4d749608dcfac0bd5c318cfc))
* **pragma:** make the Windows runtime and test suite work ([4e3c229](https://github.com/pragma-sh/pragma/commit/4e3c229b346edb43e0b622f470267ed9ad2f9641))
* **server:** guard startup with lock and socket probes ([ffe78bd](https://github.com/pragma-sh/pragma/commit/ffe78bd69a5ef647f8461a9399543c458f901780))
* **server:** query pty size in PowerShell ([a1c1c0c](https://github.com/pragma-sh/pragma/commit/a1c1c0c78b0252abc8cb8554b9a665019388c9d3))


### Performance Improvements

* reduce idle CPU/memory across server, watcher, and sidebars ([1752305](https://github.com/pragma-sh/pragma/commit/1752305acaa4073eb6736ce6b56d56ea5129c974))
* reduce idle CPU/memory across server, watcher, and sidebars ([39421e6](https://github.com/pragma-sh/pragma/commit/39421e693baf61136aae261de5019928b2e38abf))
