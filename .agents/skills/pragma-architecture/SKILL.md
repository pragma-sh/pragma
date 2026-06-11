---
name: pragma-architecture
description: Use when deciding WHERE new code, values, types, or components should live in the Pragma monorepo, or when considering whether to create a new package/directory. Covers the repo map and the clean/reusable-architecture rules.
---

# Pragma architecture & placement rules

Pragma is a Bun + Turborepo monorepo. The guiding priority is a **clean, reusable
architecture** with **consistent conventions across TypeScript and Rust**.

## Repo map

- `apps/pragma/src/` — React 19 + TS frontend.
  - `components/ui/` — shadcn/ui primitives (generated; don't hand-edit).
  - `lib/tauri.ts` — the ONLY place `invoke()` is called; typed wrappers per command.
  - `lib/utils.ts` — `cn()` + small reusable helpers.
- `apps/pragma/src-tauri/` — Rust backend (`src/lib.rs` = commands + wiring).
- `packages/constants/` — dual TS+Rust package; the single source of truth for values
  shared across the language boundary (`schema.json` + `values.json`).

## Where does it go?

| What you're adding                               | Where                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| Value used by BOTH frontend and backend          | `packages/constants` (`values.json`)           |
| Value/helper shared by multiple frontend modules | `apps/pragma/src/lib/`                         |
| Reusable logic/types a future app could use      | a NEW `packages/*` package                     |
| Code that calls the Rust backend                 | `apps/pragma/src/lib/tauri.ts`                 |
| A reusable UI primitive                          | `bunx shadcn@latest add <c>` → `components/ui` |
| A feature component (composition of primitives)  | elsewhere under `src/`                         |

## Decision rules

1. **Reuse before writing.** Grep for an existing helper/constant/component first.
2. **Extract on the second use.** Duplicated logic moves to `src/lib/` or a package.
3. **Create packages freely.** Small single-purpose packages > sprawling apps. If it's
   shared or could be, give it a `packages/*` home.
4. **No magic values across the boundary.** Put them in `@pragma/constants`.
5. **Sweeping refactors for clarity are welcome** — this project is early.

Full details: see `AGENTS.md` at the repo root.
