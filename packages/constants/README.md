# @pragma-sh/constants

Shared constants for Pragma's TypeScript and Rust sides. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Generated from one `schema.json` + `values.json` pair, so the frontend, the host
and every client agree on names, defaults and wire shapes without a value being
copied across the language boundary.

```sh
bun add @pragma-sh/constants
```

```ts
import { constants } from "@pragma-sh/constants";
```

Published as TypeScript source; consume it through a bundler or Bun. Most
integrations want [`@pragma-sh/sdk`](https://www.npmjs.com/package/@pragma-sh/sdk)
instead — this is the low-level shared vocabulary it is built on.

Docs: <https://pragma-app.sh/docs>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
