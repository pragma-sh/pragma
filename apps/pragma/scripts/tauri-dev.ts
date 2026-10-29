import { fileURLToPath } from "node:url";

import { findAvailableDevPort } from "./dev-port";

const port = await findAvailableDevPort();
const devUrl = `http://localhost:${port}`;

console.log(`Starting Pragma Dev at ${devUrl}`);

const child = Bun.spawn(
  [
    process.execPath,
    "x",
    "tauri",
    "dev",
    "--config",
    "src-tauri/tauri.dev.conf.json",
    "--config",
    JSON.stringify({ build: { devUrl } }),
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PRAGMA_DEV_PORT: String(port) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await child.exited;
