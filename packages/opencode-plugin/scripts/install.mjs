import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pin the exact release being installed. OpenCode caches a bare package name
// once and never re-resolves it, so an unpinned entry keeps loading whichever
// version it first fetched after every Pragma upgrade.
const packageJson = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);
const specifier = `${packageJson.name}@${packageJson.version}`;

const configPath =
  process.env.OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.json");
let config = {};
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw new Error(
      `${configPath} must be valid JSON before Pragma can install its OpenCode plugin`,
      { cause: error },
    );
  }
}
const isOurs = (entry) => entry === packageJson.name || entry.startsWith(`${packageJson.name}@`);
const plugins = [
  ...(Array.isArray(config.plugin) ? config.plugin : []).filter(
    (entry) => typeof entry !== "string" || !isOurs(entry),
  ),
  specifier,
];
await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`, {
  mode: 0o600,
});
