# create-pragma-plugin

Scaffold a Pragma plugin. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Generates a self-contained Vite project for a pure-TypeScript Pragma plugin:
a single ESM bundle, React aliased to the host's instance, and a test setup.

```sh
bun create pragma-plugin my-plugin
# or: npm create pragma-plugin my-plugin
```

Capabilities: `ui` (sidebar tab), `commands`, `agents`. Pass
`--capabilities ui,commands` to skip the prompt.

Docs: <https://pragma-app.sh/docs/plugins/getting-started>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
