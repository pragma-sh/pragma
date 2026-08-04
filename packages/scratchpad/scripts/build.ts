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
    // No `--packages bundle`: inlining `@pragma/sdk` makes Bun's Windows bundler
    // panic ("Expected pretty file path to have only forward slashes") on the
    // `node_modules\@pragma\sdk\dist\index.js` path, which is outside the entry
    // root. Consumers (the desktop app's Vite build) resolve the workspace
    // package themselves.
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
