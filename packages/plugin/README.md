# @pragma-sh/plugin

Build a Pragma plugin in TypeScript. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Sidebar tabs, cards, commands, themes, web views and launchable agents, plus the
React runtime the host provides. Scaffold a project with
[`create-pragma-plugin`](https://www.npmjs.com/package/create-pragma-plugin)
rather than wiring this up by hand.

```sh
bun create pragma-plugin my-plugin
```

```ts
import { definePlugin, defineSidebarTab } from "@pragma-sh/plugin";
```

React, React DOM and the JSX runtime are re-exported under
`@pragma-sh/plugin/react`, `/react-dom` and `/jsx-runtime` — alias them in your
bundler so your plugin shares the host's single React instance.

Docs: <https://pragma-app.sh/docs/plugins/getting-started>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
