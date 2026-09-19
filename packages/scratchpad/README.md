# @pragma-sh/scratchpad

Interactive components for Pragma scratchpads. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

The browser-safe API bundled into an agent-authored MDX scratchpad: ask the user
a question, review a diff, show live agent progress, and prompt the attached
agent back. Re-exports `@pragma-sh/sdk`.

```mdx
import { AskQuestion } from "@pragma-sh/scratchpad/ui";

<AskQuestion question="Which auth strategy?" options={[{ label: "JWT" }]} />
```

Components render against the desktop's theme variables, so they follow whatever
theme the user has set. Presentational primitives live under
`@pragma-sh/scratchpad/ui/primitives`.

Docs: <https://pragma-app.sh/docs/user-guide/scratchpads>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
