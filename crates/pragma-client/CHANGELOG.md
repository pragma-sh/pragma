# Changelog

## 1.0.0 (2026-09-12)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* **platform:** add Windows support via pragma-platform crate ([c291b78](https://github.com/pragma-sh/pragma/commit/c291b7815418a82017dac1cc1753ca0bde059e43))
* **pragma-cli:** support headless concurrent agent verify ([528e8e7](https://github.com/pragma-sh/pragma/commit/528e8e72972c95960ee4961a6fc4bb5f2d01269d))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** upgrade xterm and add cursor-based terminal reconnect ([2e4e0b2](https://github.com/pragma-sh/pragma/commit/2e4e0b2c55c55a80d0376ea0dce8263c784fa8a7))


### Bug Fixes

* **client:** drop unused async on check_server_key ([6d07f73](https://github.com/pragma-sh/pragma/commit/6d07f73153111fe6a2bd2d247c059e2d999c4722))
* **platform:** plain canonical paths, windowless spawns, macOS-only transparency ([78f003f](https://github.com/pragma-sh/pragma/commit/78f003f0b4b1054b76f4d1cce51f26728f42538f))
* **pragma:** make the Windows runtime and test suite work ([4e3c229](https://github.com/pragma-sh/pragma/commit/4e3c229b346edb43e0b622f470267ed9ad2f9641))
* **rust:** satisfy clippy 1.98 lints that failed Windows CI ([09efefd](https://github.com/pragma-sh/pragma/commit/09efefdc5a3c0436bdc022a62b091c27fc0cc380))


### Performance Improvements

* reduce idle CPU/memory across server, watcher, and sidebars ([1752305](https://github.com/pragma-sh/pragma/commit/1752305acaa4073eb6736ce6b56d56ea5129c974))
* reduce idle CPU/memory across server, watcher, and sidebars ([39421e6](https://github.com/pragma-sh/pragma/commit/39421e693baf61136aae261de5019928b2e38abf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pragma-platform bumped from 0.0.0 to 1.0.0
