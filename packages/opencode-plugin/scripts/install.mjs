import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
const plugins = Array.isArray(config.plugin) ? config.plugin : [];
if (!plugins.includes("@pragma-sh/opencode-plugin")) plugins.push("@pragma-sh/opencode-plugin");
await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`, {
  mode: 0o600,
});
