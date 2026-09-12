# Pragma Plugin API Reference

`@pragma/plugin` is public TypeScript API for trusted extensions rendered and run by Pragma.
Use plugin for persistent UI, command-palette actions, launchable agents, usage limits, themes,
or event-driven integration. Use `@pragma/automations` instead for UI-free scheduled tasks.

Installed TypeScript declarations remain authority for exact fields.

## Start Plugin

In Pragma repository, scaffold plugin with:

```sh
bun run --filter create-pragma-plugin build
bun packages/create-pragma-plugin/dist/cli.js ./my-plugin \
  --name my-plugin --pm bun --capabilities ui,commands,agents
```

Generated README contains build and load instructions. Add local plugin to project
`.pragma/config.json`:

```json
{
  "plugins": [{ "path": "./my-plugin" }]
}
```

Only load code user trusts. Plugin runs with access to local Pragma context and host actions.

Plugin bundle must default-export one `definePlugin(...)` result:

```tsx
import { defineCommand, definePlugin, defineSidebarTab, useProject } from "@pragma/plugin";
import { Button } from "@pragma/plugin/ui";

function ProjectOverview() {
  const project = useProject();
  return <Button>{project?.name ?? "No project selected"}</Button>;
}

export default definePlugin({
  name: "Project Tools",
  description: "Project-specific actions and status",
  ui: {
    sidebarTabs: [
      defineSidebarTab({ id: "overview", title: "Overview", component: ProjectOverview }),
    ],
  },
  commands: [
    defineCommand({
      id: "project-tools.greet",
      title: "Greet active project",
      run: (ctx) => ctx.notify(`Hello ${ctx.project?.name ?? "from Pragma"}`),
    }),
  ],
});
```

## Contributions

| Helper                     | User-facing result                                         |
| -------------------------- | ---------------------------------------------------------- |
| `defineSidebarTab`         | Tab in project sidebar.                                    |
| `defineSidebarCard`        | Card in project sidebar.                                   |
| `defineTopperItem`         | Item in workspace topper bar.                              |
| `defineSettingsPage`       | Page in Pragma Settings.                                   |
| `defineWebView`            | React workspace tab; returned handle has `.open(options)`. |
| `defineCommand`            | Command-palette action with optional default keybinding.   |
| `defineAgent`              | Coding agent available in Pragma launcher.                 |
| `defineWatcher`            | Session watcher for plugin-contributed agent.              |
| `defineUsageLimitProvider` | Provider shown in shared usage-limits UI.                  |
| `defineTheme`              | Selectable light/dark palette in Theme settings.           |

Register definitions on matching `definePlugin` fields: `ui`, `commands`, `agents`,
`watchers`, `usageLimits`, and `themes`.

`defineTheme` colors are Pragma theme-token names without the `--` prefix, and both
`light` and `dark` maps must be supplied:

```ts
defineTheme({
  id: "midnight",
  name: "Midnight",
  colors: {
    light: { background: "#ffffff", foreground: "#111111", primary: "#335cff" },
    dark: { background: "#11131a", foreground: "#e8eaf0", primary: "#8aa2ff" },
  },
});
```

Selecting a palette copies it into that scope's `.pragma/theme.json`; Pragma keeps no
runtime dependency on the plugin. Bundled and global plugin themes appear at both settings
scopes; project plugin themes appear only for their active project.

`definePlugin` also supports:

- `config`: Zod schema for validated user configuration.
- `settings` and `keybindings`: default contributed values, merged unless strategy is
  `"replace"`.
- `events`: declarative `agent.report` and plugin `deepLink` handlers.
- `css`: plugin styling.
- `onInstall`: runs once when this Pragma installation first discovers the plugin id.
- `onPragmaLoad`: runs once per Pragma server boot.

  Both receive plugin-specific `PluginContext`; failures are logged and retried on a later
  load. Keep them idempotent — Pragma persists each successful completion immediately, but
  no process can atomically combine an external side effect with its completion marker.

- `activate`: desktop activation callback; return cleanup function for subscriptions.

## Plugin Context

Callbacks receive `PluginContext<TConfig>`:

| Member      | Use                                                     |
| ----------- | ------------------------------------------------------- |
| `pluginId`  | Stable package-derived plugin identity.                 |
| `pluginDir` | Package directory when runtime exposes it.              |
| `config`    | User config parsed by plugin Zod schema.                |
| `project`   | Active project or `null`.                               |
| `sdk`       | Typed `@pragma/sdk` client. Read `sdk.md`.              |
| `notify`    | In-app notification; can request native notification.   |
| `storage`   | Optional durable JSON storage scoped to current plugin. |

Use `ctx.sdk` for filesystem, Git, sessions, agents, and other Pragma actions. Do not call
private routes or application code. Use `ctx.storage.get/set/delete` for imperative durable
state; plugin never supplies its own plugin id.

## React Hooks

Plugin components can use:

- Context: `useProject`, `usePluginConfig`, `useTheme`, `useSdk`.
- UI behavior: `useNotify`, `useStoredState`, `useWebViewPayload`.
- Generic data: `useSdkQuery`, `useEvent`.
- Pragma state: `useWorktreeChanges`, `useBranchStatus`, `useDirEntries`,
  `useFileContents`, `useAgentStatuses`, `useAgentMessages`, `useSessions`.

Query hooks return `{ data, error, loading, refetch }`. Components must render loading,
empty, and error states. Pass stable dependency arrays to `useSdkQuery`.

Use host-provided UI primitives from `@pragma/plugin/ui` (`Button`, `Kbd`) and host icons
from `@pragma/plugin/icons`. Do not import UI from `apps/pragma`.

## Web Views

```tsx
import { defineWebView, useWebViewPayload } from "@pragma/plugin";

interface ReportPayload {
  path: string;
}

function Report() {
  const payload = useWebViewPayload<ReportPayload>();
  return <pre>{payload?.path}</pre>;
}

export const reportView = defineWebView<ReportPayload>({
  id: "report",
  title: "Report",
  component: Report,
});

await reportView.open({ payload: { path: "report.json" }, dedupeKey: "latest" });
```

Payload must be JSON-serializable. Use `dedupeKey` to focus matching existing tab instead of
opening duplicates.

## Launchable Agents

```ts
import { defineAgent } from "@pragma/plugin";
import icons from "@pragma/plugin/icons";

const agent = defineAgent({
  id: "example",
  name: "Example",
  icon: icons.Bot,
  launch: { command: ["example", "--interactive"] },
  models: [{ id: "default", name: "Default" }],
  permissionModes: [],
  args: {
    model: (id) => ["--model", id],
    reasoning: (id) => ["--effort", id],
    permissionMode: () => [],
  },
});
```

Models may be static or async `(ctx) => Promise<AgentModelEntry[]>`. Keep host-tool parsing
inside plugin. `excludeFeatures` tells `pragma-cli agent verify` which optional scenarios tool
does not support. Read `agent-plugin.md` before implementing lifecycle/status integration.

## Constraints

- Bundle one browser-safe ESM entry. Avoid static `node:` imports and module-scope `process`.
- Do not bundle React. Use scaffolded aliases to `@pragma/plugin/react`, `react-dom`, and
  `jsx-runtime`.
- Import only public package exports; never app, server, or private bridge internals.
- Keep ids stable and unique within plugin. Prefix command ids with plugin/package name.
- Treat config and payloads as user input. Validate before file or process operations.
- Return cleanup from `activate`, event listeners, and watchers where API allows it.

## Verify

Run plugin's generated commands:

```sh
bun run typecheck
bun run test
bun run build
```

For agent contributions, also run `pragma-cli agent verify --agent <catalog-id>`; verification
launches real sessions and may consume model tokens.

## Publication Handoff

Complete this handoff every time this skill creates a plugin, after implementation and
verification. First classify its ownership:

- **Internal plugin:** source belongs in `pragma-sh/pragma` under `packages/*-plugin` and
  follows that repository's release process.
- **External plugin:** source lives in its own repository and is independently published.

Do not publish or open a pull request without explicit approval for the matching route.

### Internal Plugin

Ask:

> Would you like me to push this internal plugin through the Pragma repository and open a pull
> request that adds it to the official plugin list?

After approval:

1. Keep the plugin in its existing `pragma-sh/pragma` worktree and branch. Do not create a
   separate repository, clone Pragma again, or publish the npm package directly.
2. Read root `AGENTS.md`, the package's `AGENTS.md`, and
   `packages/plugin-registry/AGENTS.md`. Add package name to sorted
   `packages/plugin-registry/official.json` `packages` array and make any other registry or
   workflow changes those current instructions require.
3. Run package checks, `pragma-cli agent verify` when applicable, and repository-required checks.
   Never hand-edit `packages/plugin-registry/official.lock.json`; internal releases and lock
   refreshes use repository's `.github/workflows/plugins.yml` process.
4. Commit with a Conventional Commit message, push current branch, and run
   `gh pr create --repo pragma-sh/pragma --base main ...`. PR body must summarize plugin,
   contributions, trust surface, tests, and agent verification results.
5. Return Pragma pull-request URL. If push or PR creation fails, report exact blocker and preserve
   local work for retry.

### External Plugin

Ask:

> Would you like me to publish this plugin publicly on GitHub and npm, then open a pull request
> that adds it to Pragma's official plugin list?

Before publishing, inspect tracked and untracked files for credentials, private data, generated
artifacts, and unsuitable licenses. Confirm intended repository owner, repository name,
visibility, and npm package identity. Official list contains npm package names, so plugin must
publish to npm with root `pragma-plugin.json`. If npm publication is declined, publish only
approved GitHub repository and do not submit unusable official-list pull request.

After approval:

1. Commit completed plugin, verify `gh auth status`, and publish or push its repository with
   `gh repo create ... --source . --push` (or push its existing GitHub remote).
2. Publish approved npm release and verify public package contains built entry point and root
   `pragma-plugin.json`.
3. Clone fresh `pragma-sh/pragma` into a temporary directory with
   `gh repo clone pragma-sh/pragma <directory>`. Do not reuse plugin repository or assume an
   existing Pragma checkout is current.
4. Read clone's root `AGENTS.md` and `packages/plugin-registry/AGENTS.md`, create a focused branch,
   and add npm package name to sorted `packages/plugin-registry/official.json` `packages` array.
5. Follow cloned repository's current registry instructions and checks. Never hand-edit
   `packages/plugin-registry/official.lock.json`; regenerate it only when those instructions
   require it.
6. Commit with a Conventional Commit message, push through a fork when upstream is not writable,
   and run `gh pr create --repo pragma-sh/pragma --base main ...`. PR body must link the plugin
   repository and npm package, summarize its contributions and trust surface, and report tests
   plus `pragma-cli agent verify` results when it contributes an agent.
7. Return plugin repository URL and Pragma pull-request URL. If publishing or PR
   creation fails, report the exact blocker and preserve local work for retry.

Source: https://github.com/pragma-sh/pragma/tree/main/packages/plugin
