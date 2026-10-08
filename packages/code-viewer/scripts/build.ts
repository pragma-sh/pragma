/// <reference types="node" />
/**
 * Two-stage build, mirroring `@pragma-sh/terminal-viewer`.
 *
 * 1. esbuild bundles `src/runtime/main.ts` — CodeMirror and every grammar in
 *    `@codemirror/language-data` — into one IIFE, written out as a TypeScript
 *    string constant. The document this package produces has no
 *    network and no module loader, so the runtime has to arrive inline; string
 *    constants are what let a native client ship it with no bundler of its own.
 * 2. bunup emits the package's own ESM/CJS/`.d.ts` output.
 *
 * The shared steps live in `scripts/package-build.ts` at the repository root.
 */
import {
  bundleRuntime,
  runBunup,
  runtimeOnly,
  writeStringModule,
} from "../../../scripts/package-build.ts";

await writeStringModule("src/generated/runtime-script.ts", {
  CODE_RUNTIME_SCRIPT: await bundleRuntime("src/runtime/main.ts"),
});

if (!runtimeOnly()) runBunup(["src/index.ts"]);
