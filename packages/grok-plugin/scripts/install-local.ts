// Installs the Pragma status bridge into grok as a *global* hook file.
//
// Why not `grok plugin install`? Grok 0.2.114 discovers a plugin's
// `hooks/hooks.json` (it shows up in `grok inspect` and `/hooks`) but never adds
// it to the dispatcher's source list: `hooks: starting discovery
// global_sources=4 project_sources=0` counts only `~/.grok/hooks/`, the Claude
// settings files, and the Cursor one — so a plugin-provided hook simply never
// fires. Global hooks in `~/.grok/hooks/` are always discovered and always
// trusted (no `/hooks-trust` step, and no project-trust prompt).
//
// `hooks/hooks.json` stays the single source of truth for the event map; this
// only rewrites `${GROK_PLUGIN_ROOT}` to this package's absolute path, because a
// global hook file gets no plugin-root injection. It therefore points back at
// this checkout — edits to `hooks/report.sh` take effect on grok's next session
// with no reinstall.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where grok reads always-trusted personal hooks from. */
const HOOKS_DIR = join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "hooks");
const INSTALLED_NAME = "pragma-grok.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "hooks", "hooks.json"), "utf8");
const resolved = source.replaceAll("${GROK_PLUGIN_ROOT}", root);

mkdirSync(HOOKS_DIR, { recursive: true });
const target = join(HOOKS_DIR, INSTALLED_NAME);
writeFileSync(target, resolved);

process.stdout.write(`Installed the Pragma Grok hooks to ${target}\n`);
process.stdout.write(`They run \`${join(root, "hooks", "report.sh")}\`.\n`);
process.stdout.write("Start a new Grok session (or press `r` in /hooks) to load them.\n");
