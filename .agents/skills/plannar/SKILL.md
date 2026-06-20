---
name: plannar
description: Use when the user asks for a plan, design doc, proposal, or implementation breakdown. Plannar writes plans as MDX files in `.plannar/plans/` using shadcn/ui components (Tabs, Accordion, Cards) and interactive Playground previews so the output is skimmable and token-efficient instead of a wall of markdown. Covers the full workflow — explore the codebase, design with Plan agents, review, then author the MDX — plus shadcn component usage, Playground state bindings, and `.plannar` config.
---

# Plannar

Plannar plans are MDX files in `.plannar/plans/`. Use shadcn/ui components to make them skimmable instead of walls of text. The agent only ever edits files in `.plannar/plans/`.

This file is the planning workflow. Each layer has a reference — read the matching one when you reach it:

- **`references/mdx.md`** — how to write the plan MDX: MDX-vs-markdown gotchas, layout philosophy, prose conventions. Read before authoring in Phase 4.
- **`references/jsx.md`** — the JSX layer: shadcn components, HTML elements, the `bind` prop, and Playground.
- **`references/cli.md`** — the Plannar CLI (`init`, `editor`, `status`, `inspect`, `install-skills`).
- **`references/structure.md`** — the `.plannar/` folder anatomy.
- **`references/config.md`** — `plannar.config` fields, custom bindings, and CSS overrides.

## Creating a plan

### Phase 1 — Understand

Read the relevant code. Launch Explore agents **in parallel** sized to the uncertainty:

- **1 agent** (default): known files, targeted change, or user-provided paths.
- **2–3 agents max**: scope spans multiple subsystems, or you need to learn existing patterns before designing. Give each agent a distinct focus (e.g. one searches existing implementations, one explores related components, one investigates tests).

Then use the question tool to resolve real ambiguities up front. Quality over quantity.

### Phase 2 — Design

Launch a Plan agent to validate your understanding and consider alternatives. Skip only for true one-liners (typo, rename, single-line fix).

Use **multiple** Plan agents when the task touches several parts of the codebase, is a large refactor or architectural change, has many edge cases, or genuinely benefits from comparing approaches:

- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactor: minimal change vs clean architecture

In each agent prompt include: full Phase 1 context (file paths, code traces), requirements and constraints, and a request for a detailed implementation plan.

### Phase 3 — Review

Read the critical files the agents flagged to deepen your own understanding. Confirm the plans still match the user's intent. Use the question tool for anything material that's still unresolved.

### Phase 4 — Present

Write the final plan to `.plannar/plans/<kebab-case-name>.mdx`. **This is the only file you edit.** Before authoring, read **`references/mdx.md`** for MDX rules and layout, and **`references/jsx.md`** for components and Playground.

After writing the plan, **verify it compiles**. Plans are MDX + JSX, so a typo or a bad binding becomes a compile error rather than a visibly broken render — catch it before handing the plan over:

```sh
plannar inspect --plan <slug>
```

`<slug>` is the plan filename without `.mdx` (e.g. `hello-world`). Omit `--port` — `inspect` targets the current project's editor automatically. It exits `0` if the plan compiles and `1` — printing the errors — if not. If no editor is running, start one with `plannar editor`. Fix anything it reports and re-run until clean.

See **`references/cli.md`** for the full `inspect` reference.
