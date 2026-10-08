/// <reference types="node" />

import { runBunup } from "../../../scripts/package-build.ts";

runBunup(
  ["src/index.ts", "src/ui.tsx", "src/primitives.tsx"],
  [
    // No `--packages bundle`: consumers (the desktop app's Vite build) resolve
    // `@pragma-sh/sdk` themselves, so inlining it here would ship a second copy of
    // the SDK — and a second set of its module-level singletons — into the app
    // bundle. This used to double as a workaround for a Windows bunup panic;
    // that cause is gone (see patches/bunup@0.16.32.patch), the dedupe reason
    // is not.
    "--external",
    "@pragma-sh/sdk",
    "--external",
    "react",
    "--external",
    "react/jsx-runtime",
    "--external",
    "react/jsx-dev-runtime",
  ],
);
