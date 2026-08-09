/// <reference types="node" />

import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "x",
    "bunup",
    "src/index.ts",
    "src/ui.tsx",
    "src/primitives.tsx",
    "--format",
    "esm,cjs",
    "--target",
    "browser",
    "--dts",
    "--no-splitting",
    // No `--packages bundle`: consumers (the desktop app's Vite build) resolve
    // `@pragma/sdk` themselves, so inlining it here would ship a second copy of
    // the SDK — and a second set of its module-level singletons — into the app
    // bundle. This used to double as a workaround for a Windows bunup panic;
    // that cause is gone (see patches/bunup@0.16.32.patch), the dedupe reason
    // is not.
    "--external",
    "@pragma/sdk",
    "--external",
    "react",
    "--external",
    "react/jsx-runtime",
    "--external",
    "react/jsx-dev-runtime",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
