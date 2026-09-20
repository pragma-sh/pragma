# @pragma-sh/scratchpad-contract

The Pragma scratchpad file contract. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Pure data: the managed frontmatter of a `.mdx` scratchpad and the sibling
`<file>.mdx.comments.json` thread. No React, no renderer, no transport.

Everything that reads or writes those two files should go through here — a
second implementation of frontmatter parsing or comment serialization is how
clients drift apart and a comment written on one device stops showing up on
another.

```sh
bun add @pragma-sh/scratchpad-contract
```

```ts
import { parseScratchpadDocument } from "@pragma-sh/scratchpad-contract";
```

Docs: <https://pragma-app.sh/docs/sdk/scratchpads>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
