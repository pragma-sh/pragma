#!/usr/bin/env bun
/**
 * Generates `src/generated/constants.ts` from `schema.json` — writing the file
 * only when its contents actually change.
 *
 * Also copies `crates/pragma-protocol`'s Cargo version into
 * `values.json` `daemon.protocolVersion`, so TypeScript pairing/health never
 * hand-edit a parallel constant. A no-op write is skipped for the same reason
 * as the generated types: `tauri dev` watches this package as a Cargo path
 * dependency and restarts on any file write.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { compileFromFile } from "json-schema-to-typescript";

const SCHEMA = "schema.json";
const VALUES = "values.json";
const PROTOCOL_CARGO = "../../crates/pragma-protocol/Cargo.toml";
const OUTPUT = "src/generated/constants.ts";
const BANNER = "/* AUTO-GENERATED from schema.json. Do not edit. Run `bun run generate`. */";

const cargoToml = await readFile(PROTOCOL_CARGO, "utf8");
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
if (!cargoVersion) {
  throw new Error(`${PROTOCOL_CARGO} is missing a package version`);
}

const valuesText = await readFile(VALUES, "utf8");
const values = JSON.parse(valuesText) as { daemon: { protocolVersion: string } };
if (values.daemon.protocolVersion !== cargoVersion) {
  values.daemon.protocolVersion = cargoVersion;
  await writeFile(VALUES, `${JSON.stringify(values, null, 2)}\n`);
  console.log(`${VALUES} daemon.protocolVersion synced to ${cargoVersion}`);
}

const generated = await compileFromFile(SCHEMA, {
  additionalProperties: false,
  unreachableDefinitions: true,
  bannerComment: BANNER,
});

const existing = await readFile(OUTPUT, "utf8").catch(() => undefined);
if (existing === generated) {
  console.log(`${OUTPUT} already up to date`);
} else {
  await mkdir("src/generated", { recursive: true });
  await writeFile(OUTPUT, generated);
  console.log(`${OUTPUT} ${existing === undefined ? "created" : "updated"}`);
}
