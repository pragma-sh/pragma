/// <reference types="node" />
/**
 * Two-stage build.
 *
 * 1. esbuild bundles `src/runtime/main.tsx` — React, the MDX compiler, and the
 *    `@pragma-sh/scratchpad` components — into one IIFE, which is written out as a
 *    TypeScript module exporting it as a string. The document this package
 *    produces has no network and no module loader, so the runtime has to arrive
 *    inline; a string constant is what lets a native client ship it with no
 *    bundler of its own and no asset to resolve at run time.
 * 2. bunup emits the package's own ESM/CJS/`.d.ts` output, with that generated
 *    module already in place.
 *
 * The shared steps live in `scripts/package-build.ts` at the repository root.
 */
import {
  bundleRuntime,
  runBunup,
  runtimeOnly,
  writeStringModule,
} from "../../../scripts/package-build.ts";

const [viewer, exporter] = await Promise.all([
  bundleRuntime("src/runtime/main.tsx", { jsx: true }),
  bundleRuntime("src/runtime/export.ts", { jsx: true }),
]);
await Promise.all([
  writeStringModule("src/generated/runtime-script.ts", { VIEWER_RUNTIME_SCRIPT: viewer }),
  writeStringModule("src/generated/export-script.ts", { EXPORT_RUNTIME_SCRIPT: exporter }),
]);

if (!runtimeOnly()) runBunup(["src/index.ts"]);
