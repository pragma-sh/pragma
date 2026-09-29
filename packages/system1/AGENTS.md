# `@pragma-sh/system1` — System 1 Model Client

Typed, dependency-free client for **System 1 models**: TypeSafe's
[Jev](https://docs.typesafe.ai) and any API that speaks the same `systemone`
evaluation contract. Read the root [`AGENTS.md`](../../AGENTS.md) first.

A System 1 model is a classifier, not a text generator. One request evaluates a
`state` against named `noul` / `choice` / `score` questions and returns
calibrated probabilities for each. Ask everything you need in **one** request —
questions are evaluated in parallel, so a second round-trip only adds latency.

## Responsibilities

- `evaluate` — send one request, validate every answer against the question
  type it answers, and throw a typed `System1Error` (`kind`: `auth`,
  `rate-limit`, `bad-request`, `server`, `network`, `timeout`,
  `invalid-response`) on any failure.
- `checkEndpoint` — the cheapest possible request, for a Settings "Test" button.
- Option-count limits (`MAX_CHOICE_OPTIONS`, `MAX_SCORE_LEVELS`) are checked
  before sending, so an oversized request fails locally with a clear message.

## Rules

- **No Pragma knowledge here.** Credentials, settings, agents, and auto mode
  belong to the caller (`packages/ai-helpers/src/auto-select`). This package
  takes a base URL and key and nothing else.
- **Keep it dependency-free** and runnable wherever the platform `fetch` is.
- Shipped defaults (base URL, model route, endpoint path, timeouts) live in
  `@pragma-sh/constants` under `system1`, never here.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
```
