// Installs the Pragma status bridge into the Antigravity CLI with agy's own
// plugin mechanism: `agy plugin install <dir>` copies `agy-plugin/` into
// `~/.gemini/config/plugins/pragma`, replacing an earlier install of it.
//
// A copy, not a link (`plugins.json` entries are links), on purpose: Pragma
// deletes superseded `~/.pragma/plugins/npm/<name>-<version>-<uuid>` folders,
// and a link into one would leave agy running hooks that no longer exist. The
// copy is self-contained -- `hooks.json`, `hooks/report.sh`, and the bundled
// `dist/hook.mjs` -- so it keeps working until the next install replaces it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files the installed plugin needs; `dist/` is produced by `bun run build`. */
const REQUIRED = ["plugin.json", "hooks.json", "hooks/report.sh", "dist/hook.mjs", "dist/logo.svg"];

/** Runs `agy plugin install` on this package's `agy-plugin/` folder. */
export function installLocal(
  pluginDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "agy-plugin"),
  agy = process.env.PRAGMA_AGY ?? "agy",
): void {
  assertBuilt(pluginDir);
  runAgyInstall(agy, pluginDir);
  process.stdout.write("Start a new Antigravity CLI session to load the Pragma hooks.\n");
}

/** Fails with a clear message when the bundled hook has not been built. */
function assertBuilt(pluginDir: string): void {
  const missing = REQUIRED.filter((file) => !existsSync(join(pluginDir, file)));
  if (missing.length === 0) return;
  throw new Error(
    `${pluginDir} is incomplete (missing ${missing.join(", ")}); run \`bun run build\``,
  );
}

/** `agy plugin install <dir>`, with agy's own output passed through. */
function runAgyInstall(agy: string, pluginDir: string): void {
  const result = spawnSync(agy, ["plugin", "install", pluginDir], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Could not run \`${agy}\` (${result.error.message}). Install the Antigravity CLI first: https://antigravity.google`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`\`${agy} plugin install\` exited with status ${String(result.status)}`);
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    installLocal();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
