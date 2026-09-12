# Changelog

## 1.0.0 (2026-09-12)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* **agents:** improve attention reporting ([c9d77f1](https://github.com/pragma-sh/pragma/commit/c9d77f1446f684bead24ab4779cb0ce4b29aa4ca))
* **agents:** improve attention reporting ([41a3262](https://github.com/pragma-sh/pragma/commit/41a3262c6d0b26c4476528acf7ae7e31fd070f3d))
* **constants:** add scratchpad default tab title ([62c9d30](https://github.com/pragma-sh/pragma/commit/62c9d301d812c5222c15f58d382385141b57e68d))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* **kanban:** add board draft creation and reasoning ids ([1f2f6b4](https://github.com/pragma-sh/pragma/commit/1f2f6b454d6b549cf0cca7b2d7775bba2ab936f2))
* name agent terminal sessions ([90f8f30](https://github.com/pragma-sh/pragma/commit/90f8f30542a8232147adaef2e081bb442e133a5c))
* **platform:** add Windows support via pragma-platform crate ([c291b78](https://github.com/pragma-sh/pragma/commit/c291b7815418a82017dac1cc1753ca0bde059e43))
* **pragma-gateway:** push agent alerts to paired phones via Expo ([c7e9b81](https://github.com/pragma-sh/pragma/commit/c7e9b81cc74b9848726c9d9c99bf02e4e75dc79c))
* **pragma-gateway:** serve merged user theme over /v1/theme ([68f3746](https://github.com/pragma-sh/pragma/commit/68f3746073c1d7616732f26176392db915410fee))
* **pragma-go:** add browser client ([e9942a2](https://github.com/pragma-sh/pragma/commit/e9942a25f5f5104977874fa4464a9d8185119b34))
* **pragma-go:** add browser client ([48aee6b](https://github.com/pragma-sh/pragma/commit/48aee6b6f61048ff4a6c24535360b6ba613dda51))
* **pragma-mobile:** add iOS home-screen widgets ([04a42fe](https://github.com/pragma-sh/pragma/commit/04a42fe3546ec4eaa84a71e84d702a48845855d8))
* **pragma-mobile:** add worktree scratchpads ([3667610](https://github.com/pragma-sh/pragma/commit/36676106e9ae15c483a0c5e3e0968d765138d264))
* **pragma-mobile:** mirror the desktop's user theme in the app ([1130bfc](https://github.com/pragma-sh/pragma/commit/1130bfc99993812b34af33cf965f8521905a09c3))
* **pragma-mobile:** scratchpads on mobile, shared scratchpad contract ([b3aec80](https://github.com/pragma-sh/pragma/commit/b3aec8011c18209b425cdd9b23d7b934137efab7))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** upgrade xterm and add cursor-based terminal reconnect ([2e4e0b2](https://github.com/pragma-sh/pragma/commit/2e4e0b2c55c55a80d0376ea0dce8263c784fa8a7))
* push agent alerts to paired phones via Expo ([8f5295b](https://github.com/pragma-sh/pragma/commit/8f5295bfa84a4920f49f8ca0e9e2d2de9215ebb2))
* surface expo push test errors ([4790cbb](https://github.com/pragma-sh/pragma/commit/4790cbbd602519bc6ed539601fb3d7bd5b2b72fd))


### Bug Fixes

* **gateway:** cover the scratchpad tab kind in default titles ([1cc7fd4](https://github.com/pragma-sh/pragma/commit/1cc7fd4ee164dde672f486e23ba9c645a31d71c0))
* **gateway:** title scratchpad tabs from shared constants ([16f80d4](https://github.com/pragma-sh/pragma/commit/16f80d4d43de4adb95741b28f9e405c35911440c))
* **pragma-gateway:** resolve the theme home dir on the host ([1c5e9e6](https://github.com/pragma-sh/pragma/commit/1c5e9e69719923a1fa58270ec8cadf54f8235045))
* **protocol:** raise host file-descriptor limits ([9891e7c](https://github.com/pragma-sh/pragma/commit/9891e7c6ebe95225089a1e6ba38994bd6bc9484c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pragma-platform bumped from 0.0.0 to 1.0.0
