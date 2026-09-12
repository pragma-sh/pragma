# Changelog

## 1.0.0 (2026-09-12)


### Features

* add terminal benchmark suite, cursor-based reconnect, managed watcher lifecycle, and scoped pane focus ([809cdd6](https://github.com/pragma-sh/pragma/commit/809cdd65840bae1ce32fde7baabb67bbf0bdad96))
* **bench:** reintroduce terminal latency benchmark, fix kill() stderr leak ([25ed749](https://github.com/pragma-sh/pragma/commit/25ed7490f408116437566f5f5af6473785b0ddfd))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* **platform:** add Windows support via pragma-platform crate ([c291b78](https://github.com/pragma-sh/pragma/commit/c291b7815418a82017dac1cc1753ca0bde059e43))
* **pragma-mobile:** mirror the desktop's user theme in the app ([1130bfc](https://github.com/pragma-sh/pragma/commit/1130bfc99993812b34af33cf965f8521905a09c3))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))


### Bug Fixes

* **core:** run lifecycle commands on Windows ([0be4ffe](https://github.com/pragma-sh/pragma/commit/0be4ffe0e0637c9061be72e3e6367ed07cca7515))
* **platform:** decode UTF-16LE with as_chunks for clippy 1.98 ([0fcd615](https://github.com/pragma-sh/pragma/commit/0fcd615eecf256516cdf5667054857f89a1d4ef9))
* **platform:** plain canonical paths, windowless spawns, macOS-only transparency ([78f003f](https://github.com/pragma-sh/pragma/commit/78f003f0b4b1054b76f4d1cce51f26728f42538f))
* **pragma-server:** kill a terminal session's whole process tree, not just the shell ([81ea748](https://github.com/pragma-sh/pragma/commit/81ea748abe823c572b9b7f3b0739a9fb3f34bda0))
* **pragma:** harden script migration write, commit, and cwd handling ([daaddbf](https://github.com/pragma-sh/pragma/commit/daaddbf0a6c7881d9321ccad16535c64563d5ceb))
* **rust:** satisfy clippy 1.98 lints that failed Windows CI ([09efefd](https://github.com/pragma-sh/pragma/commit/09efefdc5a3c0436bdc022a62b091c27fc0cc380))


### Performance Improvements

* reduce idle CPU/memory across server, watcher, and sidebars ([1752305](https://github.com/pragma-sh/pragma/commit/1752305acaa4073eb6736ce6b56d56ea5129c974))
* reduce idle CPU/memory across server, watcher, and sidebars ([39421e6](https://github.com/pragma-sh/pragma/commit/39421e693baf61136aae261de5019928b2e38abf))
