# Changelog

## 1.0.0 (2026-09-12)


### Features

* **agents:** improve attention reporting ([c9d77f1](https://github.com/pragma-sh/pragma/commit/c9d77f1446f684bead24ab4779cb0ce4b29aa4ca))
* **agents:** improve attention reporting ([41a3262](https://github.com/pragma-sh/pragma/commit/41a3262c6d0b26c4476528acf7ae7e31fd070f3d))
* **core:** add merge base and abort commands ([4e2cd6f](https://github.com/pragma-sh/pragma/commit/4e2cd6fd8fdc7a226151dbf0f3f0966abae3313a))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* name agent terminal sessions ([90f8f30](https://github.com/pragma-sh/pragma/commit/90f8f30542a8232147adaef2e081bb442e133a5c))
* **pragma-core:** add asset-friendly filesystem ops ([a15c963](https://github.com/pragma-sh/pragma/commit/a15c96388244e3233137191a4957a9d1cc671734))
* **pragma-core:** show gitignored entries and delete directory trees ([13ce324](https://github.com/pragma-sh/pragma/commit/13ce324ad0c5d5b55ad09bfe4e1ce3bf9c19683f))
* **pragma-mobile:** add worktree scratchpads ([3667610](https://github.com/pragma-sh/pragma/commit/36676106e9ae15c483a0c5e3e0968d765138d264))
* **pragma-mobile:** mirror the desktop's user theme in the app ([1130bfc](https://github.com/pragma-sh/pragma/commit/1130bfc99993812b34af33cf965f8521905a09c3))
* **pragma-mobile:** scratchpads on mobile, shared scratchpad contract ([b3aec80](https://github.com/pragma-sh/pragma/commit/b3aec8011c18209b425cdd9b23d7b934137efab7))
* **pragma-server:** fan one prompt into isolated attempts ([e3fd732](https://github.com/pragma-sh/pragma/commit/e3fd73245ce757df80638e272d170f219a209eac))
* **pragma:** add Keybindings and Agent Status settings sections ([938a298](https://github.com/pragma-sh/pragma/commit/938a2989c266b42acc68929880f82d644061cbc7))
* **pragma:** add PDF viewer with chunked binary reads via EmbedPDF ([8d914db](https://github.com/pragma-sh/pragma/commit/8d914db5c2db9e5f0809ef0acb109a40856775b9))
* **pragma:** add PDF viewing with EmbedPDF and chunked file reads ([0438237](https://github.com/pragma-sh/pragma/commit/04382379fa2e1918ba62d5450542b47fdf52dfb5))
* **pragma:** add stacked pull request support ([7345445](https://github.com/pragma-sh/pragma/commit/7345445570f72ae5976ac32da31c521dd2f1680e))
* **pragma:** add stacked pull request support ([405066c](https://github.com/pragma-sh/pragma/commit/405066c093392072f4d10f0113e87877af3c7d13))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **pragma:** multi-select and drag-and-drop files in the file tree ([c435e56](https://github.com/pragma-sh/pragma/commit/c435e56389727c267f1553e763c77c354ff5da93))
* **pragma:** polish workspace interactions ([81aed8e](https://github.com/pragma-sh/pragma/commit/81aed8e3cbc0adee9f2c1001a49ed0f8392cc23e))
* **pragma:** polish workspace interactions ([afbb18c](https://github.com/pragma-sh/pragma/commit/afbb18cf70084d79647d00558dae056227d8deab))
* **pragma:** show per-commit worktree changes ([e434057](https://github.com/pragma-sh/pragma/commit/e4340570e9a177b3d081b817a8e7bcad23b35533))
* **scratchpad:** add agent-authored MDX scratchpads ([b34ea0f](https://github.com/pragma-sh/pragma/commit/b34ea0f0629db67fbc976e4543ae74b66d052c94))
* **scratchpad:** add agent-authored MDX scratchpads ([c9ec54d](https://github.com/pragma-sh/pragma/commit/c9ec54dbde08b9514843acdbc07756186972c56d))


### Bug Fixes

* **core:** run lifecycle commands on Windows ([0be4ffe](https://github.com/pragma-sh/pragma/commit/0be4ffe0e0637c9061be72e3e6367ed07cca7515))
* **platform:** plain canonical paths, windowless spawns, macOS-only transparency ([78f003f](https://github.com/pragma-sh/pragma/commit/78f003f0b4b1054b76f4d1cce51f26728f42538f))
* **pragma-core:** drop the now-unused gitignored helper ([73d664c](https://github.com/pragma-sh/pragma/commit/73d664c5f209890129b702c72c6745a2cb5da611))
* **pragma-core:** retry transient worktree directory removals ([ce21b09](https://github.com/pragma-sh/pragma/commit/ce21b092854f53d9b875a5162821baec9939a79a))
* **pragma-gateway:** resolve the theme home dir on the host ([1c5e9e6](https://github.com/pragma-sh/pragma/commit/1c5e9e69719923a1fa58270ec8cadf54f8235045))
* **pragma:** harden script migration write, commit, and cwd handling ([daaddbf](https://github.com/pragma-sh/pragma/commit/daaddbf0a6c7881d9321ccad16535c64563d5ceb))
* **pragma:** make the Windows runtime and test suite work ([4e3c229](https://github.com/pragma-sh/pragma/commit/4e3c229b346edb43e0b622f470267ed9ad2f9641))
* **pragma:** resolve type import and menu action review findings ([7b68883](https://github.com/pragma-sh/pragma/commit/7b688838c4b5f6b966e4eaf66e3bf52f918e182c))
* **pragma:** stop sidecars on install, fix repo-root and path bugs on Windows ([5f09bf3](https://github.com/pragma-sh/pragma/commit/5f09bf3897d877635e3a2b332045085cffe1cb49))


### Performance Improvements

* reduce idle CPU/memory across server, watcher, and sidebars ([1752305](https://github.com/pragma-sh/pragma/commit/1752305acaa4073eb6736ce6b56d56ea5129c974))
* reduce idle CPU/memory across server, watcher, and sidebars ([39421e6](https://github.com/pragma-sh/pragma/commit/39421e693baf61136aae261de5019928b2e38abf))
