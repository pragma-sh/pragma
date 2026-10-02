# `@pragma-sh/ai-helpers` — Agent Guide

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

Worktree-scoped commands (`commit-message`, `commit-plan`, `pull-request`,
`inline-edit`, `ask`) receive a `--cwd` that the sidecar tools read on the **local**
filesystem. `ai.rs` therefore refuses SSH-remote worktrees until AI is routed through
the owning host; do not remove that guard to "make remote work" without a host RPC.

## The sidecar protocol (`src/cli.ts`)

`src/cli.ts` is the `bin` (`pragma-ai`). Each invocation is **one operation**
and speaks newline-delimited JSON ("NDJSON") on stdout:

- **One-shot commands** print a single terminal `result` / `error` line:
  `methods`, `status`, `set-key`, `logout`, `commit-message`, `commit-plan`,
  `pull-request`, `inline-edit`, `auto-select`, `system1-check`, `agent-progress`. Input
  (diff / JSON context / API key) arrives on **stdin**. The System 1 commands take their
  key and endpoint on stdin from `system1.rs`; a `System1Error` is reported with the code
  `system1-<kind>` (`system1-auth`, `system1-rate-limit`, …), an `AutoSelectError` (every
  agent filtered out) as `auto-unavailable`, and an `AgentProgressError` (a malformed
  request) as `progress-unavailable`.
- **`resolve-conflicts`** streams `{ type: "progress", phase: "system1", files }` once,
  then `{ type: "progress", phase: "verifying", path }` per file handed to the verifier,
  then one `result` with every file's outcome. The app writes and stages the files; the
  sidecar never touches the worktree.
- **`commit-message --note <text>`** adds what the change _is_ when the diff cannot say
  it (the merge-conflict commit uses this).
- **`ask`** streams assistant text: `{ type: "delta", text }`, optional
  `{ type: "reset" }` when a model attempt is abandoned, then
  `{ type: "result", text }` or `error`. JSON context on stdin lists the question
  and project worktrees; tools are the read-only set (`read`/`grep`/`find`/`ls`).
- **`login`** is interactive: it streams `auth` / `device-code` / `progress` /
  `prompt` / `select` events and reads NDJSON answers from stdin to drive the
  OAuth flow.

Errors are emitted as `{ type: "error", code, error }`. The `code`
distinguishes the typed "nothing to do" cases (`no-staged`, `no-committed`,
`no-changes`, `no-instruction`, `no-question`) so the Rust/UI side can message them precisely —
keep these in sync with the error classes (`NoStagedChangesError`,
`NoCommittedChangesError`, `NoWorktreeChangesError`, `NoInstructionError`,
`NoQuestionError`).

**When you change a command's shape, change `ai.rs` to match in the same
change** — the NDJSON contract is the API and there is no schema enforcing it.
The Rust side parses the last non-empty line.

## Module map (`src/`)

| File                  | Responsibility                                                                       |
| --------------------- | ------------------------------------------------------------------------------------ |
| `cli.ts`              | The `pragma-ai` sidecar entrypoint — arg parsing, NDJSON I/O, command dispatch       |
| `index.ts`            | Public package surface — re-exports only; import from here, not deep paths           |
| `auth.ts`             | Auth methods, `AuthStorage`/`ModelRegistry` creation, OAuth login, API keys          |
| `pick-model.ts`       | Ranks/selects a model for a `ModelKind` (`fast` / `standard` / `high`)               |
| `constants.ts`        | `PICK_MODEL` / `MODEL_INSIGHTS` knobs + `ModelKind`. **TS-only** (see below)         |
| `model-date.ts`       | Parses release dates out of model ids for the recency filter                         |
| `model-insights.ts`   | modelgrep client + disk cache — throughput, latency, benchmark scores                |
| `harness-insights.ts` | Terminal-Bench leaderboard (agent × model) — accuracy, time, tokens/cost per solve   |
| `disk-cache.ts`       | Versioned, TTL-bound JSON cache envelope shared by both insight feeds                |
| `automode.ts`         | Parses/merges `automode.md` and applies its include/exclude globs                    |
| `auto-select.ts`      | Auto mode: one fan-out System 1 request → agent, model, reasoning effort             |
| `conflict-markers.ts` | Parses/applies git conflict markers (`merge` + `diff3`/`zdiff3`), byte-exact endings |
| `merge-conflicts.ts`  | AI merge-conflict resolution: per-file System 1 requests, high-tier verification     |
| `agent-progress.ts`   | Sidebar progress: one System 1 request → progress (0..1) + activity verb             |
| `truncate.ts`         | Head/tail character-budget truncation shared by the System 1 state builders          |
| `prompts.ts`          | All prompt text + diff char limits + draft cleaners. Versioned & unit-tested         |
| `session.ts`          | `createPragmaSession` / `runPromptToText` / `runPromptWithFallback`                  |
| `run-failure.ts`      | Classifies a failed attempt (model vs provider) + `NoWorkingModelError`              |
| `commit-message.ts`   | `git diff --cached` → one commit message (fast model)                                |
| `commit-plan.ts`      | Whole-worktree diff → a multi-commit plan (standard model)                           |
| `pull-request.ts`     | Committed branch diff → PR title + body (standard model, tools enabled)              |
| `inline-edit.ts`      | Editor buffer + instruction → exact-text replacements (standard, read-only tools)    |
| `ask-ai.ts`           | Command-palette Q&A → streaming markdown (standard, read-only tools, whole project)  |

**`inline-edit` never writes.** Its tools are pinned to `INLINE_EDIT_TOOLS`
(`read`, `grep`, `find`, `ls`) — the buffer it is editing is usually **unsaved**, so a
model that wrote to disk would be editing a different document than the user sees.
It answers with `{oldText, newText}` replacements that must match the buffer exactly
once; the app applies them, shows the result as an accept/reject diff, and only then
does anything reach the file. Do not add `write`/`edit`/`bash` to that list.

**`ask` never writes either.** Same tool allowlist (`ASK_AI_TOOLS`). The prompt names
every project worktree path and marks the currently selected one; the session `cwd` is
the main worktree root so nested checkouts stay reachable. The UI streams deltas via
the Tauri channel the same way login streams OAuth events.

**Internal sessions never load installed Pi extensions.** `createPragmaSession` uses a
`DefaultResourceLoader` with `noExtensions: true` while retaining AGENTS files, skills,
prompts, and other context. Otherwise an installed Pragma Pi extension can observe these
SDK-only helper turns and report them as user-visible Pi agent sessions when the app was
launched from a Pragma terminal environment.

## Auto mode (`auto-select.ts`)

Auto mode is a different kind of selection from the tiers below: it picks a **launch** — an
agent CLI, one of that agent's models, and a reasoning effort — with a System 1 model
(`@pragma-sh/system1`, TypeSafe Jev by default), not an LLM.

- **One request, speculative fan-out.** It asks `agent` (a choice over the survivors),
  `model_<i>` for every agent with more than one model, and a `difficulty` score, all at
  once. Reading the winning agent's model answer costs nothing extra. Keep it one request;
  a sequential "agent, then model" call doubles the latency for no gain.
- **Hard rules are code, not prompt.** `automode.md` include/exclude globs are applied by
  `applyAutoModeFilters` before anything is sent; only its prose and `priority` reach the
  model. Never move a filter into the prompt.
- **Evidence lives in the option descriptions.** Each agent option carries its
  Terminal-Bench rows plus a relative tier per axis (`tier()`: best / above median / …);
  each model option carries modelgrep scores and, when the leaderboard ran it, its result
  inside that harness. Models are capped at `AUTO_SELECT.maxModelsPerAgent`, keeping
  benchmarked models first, because a choice accepts at most 255 options.
- **Matching is fuzzy on purpose.** `harnessMatchesAgent` compares compacted names or ids
  (`Grok Build` ~ `grok`); `rowMatchesModel` compares `insightKey`s of the model's
  `canonicalId`, id, and name and allows a suffix match (`claudefable51` ~ `fable51`).
  A version mismatch (`opus 5` vs `opus 5.5`) must **not** match.
- **Difficulty → effort** is positional: `reasoningForDifficulty` spreads 0–1 across the
  model's `reasoning` list, which plugins order lowest first.
- **The leaderboard is a web page.** `parseLeaderboardHtml` decodes the Next.js RSC
  chunks and bracket-matches the `"rows":[…]` array. If Terminal-Bench changes its page,
  the parse returns nothing and auto mode degrades to model benchmarks. The fixture test
  builds the page the way Next.js does; update it when the real shape moves.

## Merge-conflict resolution (`merge-conflicts.ts`)

The pull request pane's **Resolve Merge Conflicts**. The git side (gathering files and
per-file commit logs, writing, staging, the concluding commit) runs on the owning host in
`crates/pragma-core/src/merge_conflicts.rs`; `apps/pragma/src-tauri/src/merge_conflicts.rs`
only sequences those `git` RPCs around the model calls and never holds the project git lock
across one. The host refuses a write for a different merge (`HEAD`/`MERGE_HEAD`) or a
changed conflicted index entry, and a commit whose staged tree moved.

- **One System 1 request per file, all files at once** (`Promise.all`). Per conflict:
  a choice `c<n>` (`ours` / `theirs` / `both_ours_first` / `both_theirs_first`) phrased
  as "what would an experienced engineer pick", so its calibrated `confidence` _is_ "would
  a human pick this", and a score `c<n>_risk` over `RISK_LEVELS`. Questions in one request
  are evaluated in isolation, so never ask a follow-up that assumes the choice's answer.
- **Escalation is per file.** `confidence × (1 − riskWeight × risk)` below
  `MERGE_CONFLICTS.minCombinedScore` on any conflict, a System 1 error, or a conflict side
  cut at `maxSideChars` sends the whole file to the `high` tier with read-only tools
  (`INLINE_EDIT_TOOLS`), System 1's answers, and the same context. The verifier may answer
  `custom` with replacement text; markers in it are rejected.
- **Marker width is per conflict.** Git writes markers `conflict-marker-size` wide (7 by
  default); the `<<<<<<<` run that opens a conflict sets the width its other markers must
  match, and `ParsedConflictFile.markerSizes` feeds the still-has-markers check.
- **A failed file never fails the run.** Binary, marker-free (rename or delete), or
  malformed files come back `skipped`; model failures come back `failed`.

## Model selection

Three tiers, all picked automatically from the user's **authenticated** models:

| Tier       | Ceiling | Ranks on                           | Used by                                    |
| ---------- | ------- | ---------------------------------- | ------------------------------------------ |
| `fast`     | Sonnet  | Throughput (prefers non-reasoning) | commit message                             |
| `standard` | Sonnet  | Capability weighed against price   | commit plan, PR draft, inline edit, ask AI |
| `high`     | Opus    | Capability alone                   | _no consumer yet_                          |

`fast` shares the mid-tier ceiling with `standard` because its goal is latency,
and paying frontier rates for speed is never the trade you want.

**`high` is intentionally unused for now** — it is built, tested, and waiting for
a caller. Do not "clean it up" as dead code, and do not repoint an existing
feature at it without asking.

Three rules make this hold up over time:

- **Rankings are percentiles of the user's own pool, never absolute numbers.**
  A user with one Anthropic key and a user with the whole OpenRouter catalog
  both get a sane pick, and nothing rots when the next generation ships. Cuts
  are skipped when the pool is too small to have percentiles
  (`minPoolForPercentileCuts`) and are discarded whole rather than emptying it.
- **Price ceilings are anchored, not typed in.** `priceAnchors` names reference
  models (`claude-sonnet-5`, `claude-opus-5`) and the cap is that model's _live_
  blended price plus 10% headroom, so it moves when Anthropic reprices. Ids are
  tried in order; `fallbackBlended` applies only when modelgrep is unreachable.
  **Unlike the percentile cuts, the ceiling is hard** — it is a budget, never
  relaxed to keep the pool non-empty, so a user whose only models cost more than
  Opus gets an explicit "no model available" rather than a surprise bill.
- **Ranking bands, then recency.** Normalized scores are grouped into bands
  `tieBand` wide, grown down from the leader (not a fixed grid, which would split
  0.999 from 1.0). Inside a band, newer wins, then cheaper, then larger context,
  then id. So a 1% better score never beats a model three months newer.

### Falling back when a model fails

`runPromptWithFallback` (used by `inline-edit`) walks the ranked candidates
serially until one answers. Selection only knows what a provider _offers_, never
what it will _serve_ — a rejected key, an exhausted subscription, or a plan that
does not include the model all look identical until the request is made. Two
bounds keep that from becoming a minute of silence, both in `run-failure.ts`:

- **A provider-scoped failure retires the provider.** Auth, quota, and billing
  errors (`401`/`403`/`402`/`429`, "invalid api key", "usage limit") condemn
  every model behind that credential, so the remaining ones are skipped instead
  of re-proving the same expired key a dozen times. Everything else — `400 model
not available`, context overflow — blames only that model, and a sibling is
  tried.
- **`RUN_FALLBACK.maxAttempts` caps the walk** (3). A tier can offer twenty
  candidates and an interactive helper cannot spend twenty round-trips on them.

`NoWorkingModelError` reports **one error per provider**, not the last
candidate's. The last candidate is the worst-ranked model of whichever provider
sorted last, so its error is the least informative in the set — that is how a
rejected opencode key plus an out-of-quota Copilot surfaced in the UI as a bare
"400 model not available" after ~20s of waiting.

**Bump `MODEL_INSIGHTS.cacheVersion` whenever `ModelInsight` gains a field.** An
old cache still parses; the new field just reads `null`. When that field is one
a price ceiling is anchored to, the cap silently falls back to the offline
default for up to a day with nothing in the logs — which is exactly what
happened when pricing was added.

`model-insights.ts` supplies the data pi's registry lacks — throughput, TTFT,
and Artificial Analysis scores — from [modelgrep](https://modelgrep.com/api)
(free, no key), cached at `~/.pragma/cache/model-insights.json` for 24h.

**Treat every insight field as optional and selection as offline-safe.**
`loadModelInsights` never throws and never blocks: a timeout, an outage, or a
read-only home resolves to an empty lookup and selection degrades to the
price/recency heuristics. This is the normal path, not an edge case — as of
this writing modelgrep publishes `throughput_tps: null` for its **entire**
catalog (`/api/v1/rankings/fastest` returns `count: 0`), while ~150 of 306
models do carry an intelligence score. Hence the ladder in `fastMetric`:
throughput, then latency, then price as a size proxy.

pi ids and modelgrep ids are different dialects of the same models
(`claude-sonnet-4-5-20250929` vs `anthropic/claude-sonnet-4.5:batch`).
`insightKey` collapses both by stripping the maker prefix, variant suffix,
release date, and separators. **Unmatched models are kept, not dropped** — an
unknown model is not a bad one.

## Conventions

- **Constants live here, not in `@pragma-sh/constants`.** Model-selection knobs
  (`PICK_MODEL`, `MODEL_INSIGHTS`) never cross the TS/Rust boundary — they run
  entirely inside this JS sidecar — so they stay local. Anything that _is_
  shared with Rust still belongs in `@pragma-sh/constants` per the root guide.
- **The credential store is shared with the `pi` CLI, not Pragma's own.**
  `createAuthStorage()` resolves to `~/.pi/agent/auth.json`, so a `pi` login
  shows up in Pragma as a connected provider and model selection will route work
  to it. That is deliberate (and why `needsSetup` is independent of
  `available`), but it means "I never signed in to X in Pragma" is not evidence
  that X is unauthenticated — read the file before concluding anything about
  where a provider error came from. Settings → AI lists every provider in that
  file with a sign-out button; signing out there signs out of the CLI too.
- **Mock `./model-insights.ts` in feature tests.** `generateCommitMessage` and
  friends call `loadModelInsights()`, which will otherwise hit the real API and
  write to the developer's `~/.pragma/cache` during a test run.
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
bun run test          # bun --bun vitest run (Bun runtime, see below)
bun run lint          # oxlint .
bun run build:sidecar # bun build src/cli.ts --compile → dist/pragma-ai
```

Tests run with `bun --bun vitest run`, i.e. under **Bun's runtime**, not Node.
The pi SDK pulls in `undici@8`, which initializes a `CacheStorage` at import
time using `webidl.util.markAsUncloneable` — an API that only exists in Node
`>=22.19`. Importing this package under an older Node (some CI runners ship one)
throws `webidl.util.markAsUncloneable is not a function` before any test body
runs. Running vitest under Bun sidesteps the system-Node version entirely, so
all workspace `test` scripts use `bun --bun vitest run` for consistency.

In a **debug** build the Rust app runs `src/cli.ts` directly via `bun`; a
**release** build runs the compiled `dist/pragma-ai` staged beside the app
binary. Test changes end-to-end through both paths when touching `cli.ts`.
