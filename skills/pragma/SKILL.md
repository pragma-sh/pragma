---
name: pragma
description: Use when someone wants an agent to operate Pragma, automate a Pragma workspace, build a Pragma plugin, write a Pragma automation, integrate a coding-agent tool such as OpenCode, Claude Code, Cursor, or Codex so it reports status into Pragma and appears in its launcher, use pragma-cli or @pragma/sdk, or understand user-facing Pragma concepts such as projects, worktrees, tabs, agents, scratchpads, and fanouts.
---

# Use Pragma

Help users and agents accomplish work through Pragma's public interfaces. Start from desired outcome, choose narrowest suitable surface, and avoid implementation details.

## Product Model

Pragma is workspace for running persistent coding-agent sessions in isolated Git worktrees. It combines terminals, browser/editor tabs, agent status, scratchpads, review tools, and parallel attempts without making user manage each process or checkout manually.

Use these user-facing terms:

| Term           | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| **Project**    | Repository added to Pragma.                                                 |
| **Worktree**   | Isolated Git checkout and its tabs.                                         |
| **Tab**        | Terminal, browser, editor, diff, review, log, or scratchpad workspace item. |
| **Agent**      | Coding tool Pragma can launch and interact with.                            |
| **Scratchpad** | Managed MDX document for agent-authored rich output and collaboration.      |
| **Fanout**     | Same prompt run as isolated attempts, followed by selecting one result.     |
| **Plugin**     | Trusted extension adding UI, commands, agents, themes, or integrations.     |
| **Automation** | Trusted TypeScript/JavaScript task triggered by cron, event, or Run now.    |

Do not lead with servers, sockets, sidecars, protocol frames, Tauri, or crate names. Those describe implementation, not how agent or user gets work done.

## Choose Public Surface

| Goal                                                                        | Surface                                     | Reference                    |
| --------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| Control worktrees, tabs, agents, browser, or fanout                         | `pragma-cli`                                | `references/cli.md`          |
| Build typed JavaScript/TypeScript integration                               | `@pragma/sdk`                               | `references/sdk.md`          |
| Add Pragma UI, commands, launchable agents, themes                          | `@pragma/plugin`                            | `references/plugin-api.md`   |
| Run scheduled or event-driven host tasks                                    | `@pragma/automations`                       | `references/automations.md`  |
| Make coding-agent tool report status and appear in launcher                 | `@pragma/plugin` + `pragma-cli`             | `references/agent-plugin.md` |
| Author rich, interactive agent output (plan, comparison, review, dashboard) | Scratchpad (`pragma-cli scratchpad create`) | `references/scratchpads.md`  |
| Make repository-internal architecture change                                | `pragma-architecture` skill                 | Not this skill.              |

Prefer, in order:

1. Existing typed SDK method for TypeScript programs.
2. Existing CLI command for shell workflows and agent tool calls.
3. Automation for durable cron/event behavior.
4. Plugin for persistent UI, commands, or launcher contributions.

Never edit Pragma-managed state directly, invent private API routes, construct socket frames, or import Pragma application internals.

## Agent Workflow

1. Identify current project, worktree, and tab from task context or `PRAGMA_*` environment.
2. Inspect before mutating: list worktrees/tabs, read bounded terminal output, or query typed SDK state.
3. Make smallest scoped change through CLI or SDK. Pass explicit worktree ids when context could be ambiguous.
4. Use structured output: `--toon` for compact agent context, `--json` for programmatic use.
5. Confirm destructive actions. Worktree deletion, fanout pick, discard, and forced cleanup can remove branches, checkouts, or uncommitted work.
6. Report result in user terms: what opened, ran, changed, needs attention, or failed.

Useful agent patterns:

- Open command in managed terminal when user should see or continue interacting with it.
- Use `tab exec` or SDK `exec.run` for bounded background command needing collected output.
- Use `tab read --watch` or SDK streams for long-running output; cancel stream when finished.
- Use scratchpad for durable rich findings instead of dumping large output into chat. Never write scratchpad files by hand; read `references/scratchpads.md` for creation, MDX authoring rules, and the component API before authoring one.
- Use fanout when attempts benefit from independent branches, not merely parallel shell commands.
- Treat `attention` as user action needed, `done` as completed work worth reviewing, and `cleared` as no remaining result or stale state.

## Extending Pragma

Choose plugin when capability belongs inside Pragma's interface or agent launcher. Choose automation when code should run on schedule/event without adding UI. Choose SDK/CLI script when caller already owns lifecycle.

Before writing extension code:

1. Read matching reference file.
2. Inspect installed package declarations for exact current types.
3. Keep plugin or automation self-contained and use only public package exports.
4. Assume code has host access. Explain trust impact and avoid hidden destructive behavior.
5. Add focused tests for behavior, then run package typecheck and tests.

### Agent Plugins

An **agent plugin** integrates a host coding-agent tool — OpenCode, Claude Code, Cursor, Codex, or a new TUI agent — so it reports status into Pragma and appears in the agent launcher. It has its own routes (in-process SDK plugin, shell hooks, or `createTuiWatcher`), status and message contract, `defineAgent` registration, branding icons, and `pragma-cli agent verify` gate.

Read `references/agent-plugin.md` before writing any agent-plugin code, and derive the reporting contract only from it. `references/plugin-api.md` covers the general plugin API and does not define status semantics.

## Authority

- Documentation: <https://pragma-app.sh/docs>
- Source: <https://github.com/pragma-sh/pragma>
- Exact CLI flags: installed `pragma-cli --help` and subcommand `--help`
- Exact TypeScript contracts: installed package `.d.ts` declarations

Prefer published docs and installed declarations for user-facing answers. Consult repository internals only to resolve missing or contradictory public behavior.
