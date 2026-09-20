# @pragma-sh/sdk

Typed Node/Bun client for a Pragma host. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Talks to a Pragma host's local HTTP gateway: projects, worktrees, tabs, agents,
scratchpads, whiteboards, fanouts, and event streams. Dual ESM/CJS with
TypeScript definitions.

```sh
bun add @pragma-sh/sdk
```

```ts
import { PragmaClient } from "@pragma-sh/sdk";

// Inside a Pragma terminal both values are already in the environment.
const client = new PragmaClient();
const worktrees = await client.worktrees.list();
```

Docs: <https://pragma-app.sh/docs/sdk/getting-started>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
