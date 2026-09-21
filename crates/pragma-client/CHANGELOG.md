# Changelog

## [0.3.0](https://github.com/pragma-sh/pragma/compare/pragma-client-v0.2.0...pragma-client-v0.3.0) (2026-09-21)


### Miscellaneous Chores

* **pragma-client:** Synchronize desktop versions

## [0.2.0](https://github.com/pragma-sh/pragma/compare/pragma-client-v0.1.0...pragma-client-v0.2.0) (2026-09-20)


### Miscellaneous Chores

* **pragma-client:** Synchronize desktop versions

## 0.1.0 (2026-09-20)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* **core:** durable whiteboard store with native PNG rendering ([c9c6e3f](https://github.com/pragma-sh/pragma/commit/c9c6e3f8dd150e7706551958113257f9208d76d2))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** paste dropped files into terminals as host paths; pace agent launches on PTY connect ([e84fba3](https://github.com/pragma-sh/pragma/commit/e84fba384abd8a0e77f87e06eba4114c9077cc6e))
* **pragma:** upgrade xterm and add cursor-based terminal reconnect ([2e4e0b2](https://github.com/pragma-sh/pragma/commit/2e4e0b2c55c55a80d0376ea0dce8263c784fa8a7))


### Bug Fixes

* **client:** drop unused async on check_server_key ([6d07f73](https://github.com/pragma-sh/pragma/commit/6d07f73153111fe6a2bd2d247c059e2d999c4722))
* **pragma:** drop stale version pin on internal pragma-platform dep ([886a493](https://github.com/pragma-sh/pragma/commit/886a493b71052a8a783bf020742bf2686e7d3148))
* **rust:** satisfy clippy 1.98 lints that failed Windows CI ([09efefd](https://github.com/pragma-sh/pragma/commit/09efefdc5a3c0436bdc022a62b091c27fc0cc380))


### Performance Improvements

* reduce idle CPU/memory across server, watcher, and sidebars ([1752305](https://github.com/pragma-sh/pragma/commit/1752305acaa4073eb6736ce6b56d56ea5129c974))
* reduce idle CPU/memory across server, watcher, and sidebars ([39421e6](https://github.com/pragma-sh/pragma/commit/39421e693baf61136aae261de5019928b2e38abf))
