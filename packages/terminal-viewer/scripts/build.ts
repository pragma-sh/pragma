/// <reference types="node" />
/**
 * Two-stage build, mirroring `@pragma-sh/scratchpad-viewer`.
 *
 * 1. esbuild bundles `src/runtime/main.ts` — xterm and its addons — into one
 *    IIFE, and reads xterm's stylesheet, writing both out as a TypeScript
 *    module of string constants. The document this package produces has no
 *    network and no module loader, so the runtime has to arrive inline; string
 *    constants are what let a native client ship it with no bundler of its own.
 * 2. bunup emits the package's own ESM/CJS/`.d.ts` output.
 *
 * The shared steps live in `scripts/package-build.ts` at the repository root.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  bundleRuntime,
  runBunup,
  runtimeOnly,
  writeStringModule,
} from "../../../scripts/package-build.ts";

const require = createRequire(import.meta.url);
const xtermDir = dirname(require.resolve("@xterm/xterm/package.json"));

await writeStringModule("src/generated/runtime-script.ts", {
  TERMINAL_RUNTIME_SCRIPT: await bundleRuntime("src/runtime/main.ts"),
  TERMINAL_RUNTIME_STYLES: await readFile(join(xtermDir, "css", "xterm.css"), "utf8"),
});

if (!runtimeOnly()) runBunup(["src/index.ts"]);
