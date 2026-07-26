#!/usr/bin/env bun
/**
 * Generates `src/generated/constants.ts` from `schema.json` — writing the file
 * only when its contents actually change.
 *
 * The write-only-if-changed part is the whole point, not an optimization.
 * `generate` runs from `pretest`, `pretypecheck`, and `build`, so it fires
 * whenever anyone runs tests or a typecheck. The `tauri dev` file watcher
 * follows this package as a Cargo path dependency and reacts to the *write*,
 * not to a content change: an unconditional rewrite therefore killed the
 * running app and restarted the whole Rust build every time a test run
 * happened alongside `bun run dev`.
 *
 * Ignoring the path instead does not work — the watcher reads only
 * `.taurignore` and `src-tauri/.gitignore`, both scoped to the `src-tauri`
 * tree, and this package sits outside it.
 *
 * Rust is unaffected either way: its types come from
 * `typify::import_types!("schema.json")` at compile time, so `schema.json`
 * remains the watched input and a real schema change still rebuilds.
 */
import { readFile, writeFile } from "node:fs/promises";

import { compileFromFile } from "json-schema-to-typescript";

const SCHEMA = "schema.json";
const OUTPUT = "src/generated/constants.ts";
const BANNER = "/* AUTO-GENERATED from schema.json. Do not edit. Run `bun run generate`. */";

const generated = await compileFromFile(SCHEMA, {
  additionalProperties: false,
  unreachableDefinitions: true,
  bannerComment: BANNER,
});

const existing = await readFile(OUTPUT, "utf8").catch(() => undefined);
if (existing === generated) {
  console.log(`${OUTPUT} already up to date`);
} else {
  await writeFile(OUTPUT, generated);
  console.log(`${OUTPUT} ${existing === undefined ? "created" : "updated"}`);
}
