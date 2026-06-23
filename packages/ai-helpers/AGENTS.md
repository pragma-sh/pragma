# `@pragma/ai-helpers` — Agent Guide

> Pragma's lightweight AI layer over the **pi coding-agent SDK**
> (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`). It owns
> authentication, model selection, prompts, and the built-in AI features
> (commit-message, commit-plan, pull-request). Read the root
> [`AGENTS.md`](../../AGENTS.md) first — this file only covers what is specific
> to this package.

## What this package is for

The pi SDK is **Node-only**, so it cannot run in the Tauri Rust process or the
browser. This package is the boundary: pure TS helpers plus a CLI
(`src/cli.ts`) compiled to the `pragma-ai` sidecar binary. The Rust backend
(`apps/pragma/src-tauri/src/ai.rs`) spawns that sidecar per operation and talks
to it over NDJSON. **Nothing here ever runs in the frontend.**

```
React UI  ──invoke──▶  ai.rs (Rust)  ──spawn + NDJSON──▶  pragma-ai (this package)  ──▶  pi SDK
```

## The sidecar protocol (`src/cli.ts`)

`src/cli.ts` is the `bin` (`pragma-ai`). Each invocation is **one operation**
and speaks newline-delimited JSON ("NDJSON") on stdout:

- **One-shot commands** print a single terminal `result` / `error` line:
  `methods`, `status`, `set-key`, `logout`, `commit-message`, `commit-plan`,
  `pull-request`. Input (diff / JSON context / API key) arrives on **stdin**.
- **`login`** is interactive: it streams `auth` / `device-code` / `progress` /
  `prompt` / `select` events and reads NDJSON answers from stdin to drive the
  OAuth flow.

Errors are emitted as `{ type: "error", code, error }`. The `code`
distinguishes the typed "nothing to do" cases (`no-staged`, `no-committed`,
`no-changes`) so the Rust/UI side can message them precisely — keep these in
sync with the error classes (`NoStagedChangesError`, `NoCommittedChangesError`,
`NoWorktreeChangesError`).

**When you change a command's shape, change `ai.rs` to match in the same
change** — the NDJSON contract is the API and there is no schema enforcing it.
The Rust side parses the last non-empty line.

## Module map (`src/`)

| File                | Responsibility                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `cli.ts`            | The `pragma-ai` sidecar entrypoint — arg parsing, NDJSON I/O, command dispatch |
| `index.ts`          | Public package surface — re-exports only; import from here, not deep paths     |
| `auth.ts`           | Auth methods, `AuthStorage`/`ModelRegistry` creation, OAuth login, API keys    |
| `pick-model.ts`     | Ranks/selects a model for a `ModelKind` (`quick` / `standard`)                 |
| `constants.ts`      | `PICK_MODEL` selection thresholds + `ModelKind`. **TS-only** (see below)       |
| `model-date.ts`     | Parses release dates out of model ids for the recency filter                   |
| `prompts.ts`        | All prompt text + diff char limits + draft cleaners. Versioned & unit-tested   |
| `session.ts`        | `createPragmaSession` / `runPromptToText` over the pi agent session            |
| `commit-message.ts` | `git diff --cached` → one commit message (quick model)                         |
| `commit-plan.ts`    | Whole-worktree diff → a multi-commit plan (standard model)                     |
| `pull-request.ts`   | Committed branch diff → PR title + body (standard model, tools enabled)        |

## Conventions

- **Constants live here, not in `@pragma/constants`.** Model-selection knobs
  (`PICK_MODEL`) never cross the TS/Rust boundary — they run entirely inside
  this JS sidecar — so they stay local. Anything that *is* shared with Rust
  still belongs in `@pragma/constants` per the root guide.
- **Prompts stay in `prompts.ts`.** Keep prompt strings out of the feature
  modules so they are versioned in one place and testable without the SDK.
- **Feature modules take `authStorage` + `registry` as inputs.** Construct them
  once per CLI invocation (`createAuthStorage` → `createModelRegistry`) and pass
  them in; do not reach for global state.
- **pi auth is shared with the pi CLI** via `~/.pi/agent/auth.json`. A user may
  already be signed in there, so availability is independent of Pragma's own
  setup flow — do not assume an empty credential store.

## Commands

Run from this directory (or via `turbo` at the root):

```sh
bun run typecheck     # tsc --noEmit
bun run test          # vitest run
bun run lint          # oxlint .
bun run build:sidecar # bun build src/cli.ts --compile → dist/pragma-ai
```

In a **debug** build the Rust app runs `src/cli.ts` directly via `bun`; a
**release** build runs the compiled `dist/pragma-ai` staged beside the app
binary. Test changes end-to-end through both paths when touching `cli.ts`.
