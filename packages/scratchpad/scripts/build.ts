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
    "--packages",
    "bundle",
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
