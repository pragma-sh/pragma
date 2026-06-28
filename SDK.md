# `@pragma/sdk` — the preferred plugin route

Typed Node/Bun wrapper around the `pragma-cli` CLI. **Use this in any JS/TS plugin or
consumer that reports agent status.** It is the preferred route whenever the host tool
has an in-process JS/TS plugin API — you react to structured, typed events and never
hand-build CLI argv.

Source: `packages/sdk/` (`@pragma/sdk`). Real-world consumer:
`packages/opencode-plugin/`. See [CREATE_PLUGIN.md](./CREATE_PLUGIN.md) for the full
workflow, and [CLI.md](./CLI.md) for the underlying contract this wraps.

## What it does

Shells out to the `pragma-cli` binary (installed to `~/.local/bin` by the app on
startup) with typed options, and returns the captured result or throws a typed error. It
**guards on the Pragma environment** before spawning — `reportStarted` and friends are a
no-op outside a Pragma terminal session — so you don't need your own env check around
each call (though plugins typically add one too as defense-in-depth).

Bundled by Bunup as ESM, CJS, and `.d.ts`.

## Install

Inside the monorepo, depend on it as a workspace package:

```jsonc
// packages/<your>-plugin/package.json
{
  "dependencies": { "@pragma/sdk": "workspace:*" },
}
```

## API

Four async helpers, one per status. Each takes an options object and returns
`Promise<PragmaCliResult>`, rejecting with `PragmaCliError` on failure.

```ts
import {
  reportStarted,
  reportStopped,
  reportAttention,
  reportCleared,
  type AttentionKind, // "question" | "command"
} from "@pragma/sdk";

// yellow — agent is running
await reportStarted({ agent: "opencode" });

// green — finished normally, go look (only ever after a started)
await reportStopped({ agent: "opencode" });

// red — needs input; kind is required for this helper
await reportAttention({ agent: "opencode", kind: "question" });

// remove the indicator entirely — quit / crash / abort (NOT a green "done")
await reportCleared({ agent: "opencode" });
```

### Options

All helpers share `PragmaAgentCommandOptions`:

| Field        | Type                                  | Notes                                                       |
| ------------ | ------------------------------------- | ----------------------------------------------------------- |
| `agent`      | `string` (**required**)               | Stable agent id from your `config.json`. Maps to `--agent`. |
| `executable` | `string`                              | Path/name of the CLI. Defaults to `pragma-cli`.             |
| `cwd`        | `string \| URL`                       | Working directory for the spawned process.                  |
| `env`        | `Record<string, string \| undefined>` | Merged over `process.env` for the spawned process.          |
| `signal`     | `AbortSignal`                         | Cancels the spawned process.                                |

Helper-specific:

- `reportAttention` requires `kind: "question" | "command"` (maps to `--kind`).
- `reportStopped` / `reportCleared` accept optional `worktreeId` (maps to `--worktree-id`,
  overriding `PRAGMA_WORKTREE_ID` — rarely needed; only when reporting final status from
  a parent process).

### Environment

The spawned CLI reads `PRAGMA_SERVER_SOCKET` (falling back to legacy
`PRAGMA_DAEMON_SOCKET`), `PRAGMA_TAB_ID`, and `PRAGMA_WORKTREE_ID` from the provided
`env` (or `process.env`). These are injected by the Pragma terminal. Outside a Pragma
session they're absent and the call is a no-op.

### Errors

Failures reject with `PragmaCliError`, which carries `executable`, `args`,
`exitCode` (`number | null`), `stdout`, `stderr`, and `cause`. In a plugin you should
**swallow** these (optionally log in a debug mode) so reporting can never disrupt the
host tool — see the reporter wrapper in `packages/opencode-plugin/src/index.ts`.

## Rules

- **Never hand-build `pragma-cli` argv in a plugin** — always import from `@pragma/sdk`.
- The SDK is a no-op outside a Pragma terminal; rely on that, but still keep your plugin
  resilient (catch errors).
- Derive status with a small state machine and emit only on change — don't map one event
  to one report blindly. See `packages/opencode-plugin/src/hooks.ts`.
