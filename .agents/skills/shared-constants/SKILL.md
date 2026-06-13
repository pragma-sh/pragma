---
name: shared-constants
description: Use when adding or changing a constant/value that is shared between the TypeScript frontend and the Rust backend in Pragma — anything in packages/constants, schema.json, values.json, or generated constant types.
---

# Shared constants (TS + Rust single source of truth)

`packages/constants` is consumed by BOTH the React frontend and the Rust backend.
`schema.json` is the contract; `values.json` is the data. TS types are generated with
`json-schema-to-typescript`; Rust types with `typify` (`import_types!` macro). Rust
parses `values.json` at startup and panics if it drifts from the schema — intentional.

## To add or change a shared value

1. Edit `packages/constants/schema.json` — the shape. Give new object definitions a
   `title` (it becomes the generated type name) and set `additionalProperties: false`.
2. Edit `packages/constants/values.json` — the value. It must satisfy the schema.
3. Run `bun run generate` (regenerates TS types into `src/generated/`, including
   unreferenced definitions; Rust regenerates on next `cargo build`).
4. Consume it:
   - **TS:** `import { constants } from "@pragma/constants"` → `constants.app.name`
   - **Rust:** `pragma_constants::CONSTANTS.app.name`
5. If you exported a new top-level type, add it to the `export type { ... }` list in
   `packages/constants/src/index.ts` and the `pub use generated::{...}` in `src/lib.rs`.

## Gotchas

- JSON keys are `camelCase` (canonical). Rust fields are `snake_case` with serde rename
  handled automatically by typify — access them as `snake_case` in Rust.
- Generated code is NEVER hand-edited and is git-ignored. Change `schema.json` instead.
- If a value also configures the window/bundle, mirror it in
  `apps/pragma/src-tauri/tauri.conf.json` (Tauri reads its config statically).
- Tests already assert basic invariants (`src/index.test.ts`, `src/lib.rs` tests); add
  to them when you add structure.
