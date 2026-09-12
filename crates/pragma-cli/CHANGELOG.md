# Changelog

## 1.0.0 (2026-09-12)


### Features

* **agents:** improve attention reporting ([c9d77f1](https://github.com/pragma-sh/pragma/commit/c9d77f1446f684bead24ab4779cb0ce4b29aa4ca))
* **agents:** improve attention reporting ([41a3262](https://github.com/pragma-sh/pragma/commit/41a3262c6d0b26c4476528acf7ae7e31fd070f3d))
* fan out one prompt into isolated attempts and keep one ([a67fe08](https://github.com/pragma-sh/pragma/commit/a67fe089115d4170c29a844f9309ba830f5ea46c))
* name agent terminal sessions ([90f8f30](https://github.com/pragma-sh/pragma/commit/90f8f30542a8232147adaef2e081bb442e133a5c))
* **platform:** add Windows support via pragma-platform crate ([c291b78](https://github.com/pragma-sh/pragma/commit/c291b7815418a82017dac1cc1753ca0bde059e43))
* **pragma-cli:** add fanout commands ([3e75812](https://github.com/pragma-sh/pragma/commit/3e7581235a4c1b007be54b951850971e66598a83))
* **pragma-cli:** support headless concurrent agent verify ([528e8e7](https://github.com/pragma-sh/pragma/commit/528e8e72972c95960ee4961a6fc4bb5f2d01269d))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([bf30f5b](https://github.com/pragma-sh/pragma/commit/bf30f5b6a4cc8a9020ff5795f89fe0b5d60dc15f))
* **pragma:** let a terminal pick its shell, with WSL in the picker ([8206e89](https://github.com/pragma-sh/pragma/commit/8206e89a693f8ae2aa63b5297348791694e75404))
* **scratchpad:** add agent-authored MDX scratchpads ([b34ea0f](https://github.com/pragma-sh/pragma/commit/b34ea0f0629db67fbc976e4543ae74b66d052c94))
* **scratchpad:** add agent-authored MDX scratchpads ([c9ec54d](https://github.com/pragma-sh/pragma/commit/c9ec54dbde08b9514843acdbc07756186972c56d))


### Bug Fixes

* **cli:** use is_ok_and for prefill mode check ([4c96d7d](https://github.com/pragma-sh/pragma/commit/4c96d7dca3952b08072e1b7f58010b11bb805e0f))
* **pragma-cli:** satisfy clippy in agent verify engine ([7fc83f4](https://github.com/pragma-sh/pragma/commit/7fc83f45ae1c879142bf705d43550e3f40584d98))
* **rust:** satisfy clippy 1.98 lints that failed Windows CI ([09efefd](https://github.com/pragma-sh/pragma/commit/09efefdc5a3c0436bdc022a62b091c27fc0cc380))
* **watcher-kit:** use unit separator for multi-question answer wire format ([179e7b6](https://github.com/pragma-sh/pragma/commit/179e7b6227d997a44dd9adf34b1cb68469dc6435))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pragma-platform bumped from 0.0.0 to 1.0.0
