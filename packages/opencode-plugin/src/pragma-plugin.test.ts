import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { opencodeAgentPlugin } from "./pragma-plugin";

const sourceDir = dirname(fileURLToPath(import.meta.url));

/** Modules bundled into `dist/pragma-plugin.mjs`, the entry the webview imports. */
const ENTRY_MODULES = ["pragma-plugin.ts", "usage-limits.ts", "cwd.ts"];

describe("opencode plugin entry", () => {
  it("contributes the launchable OpenCode agent", () => {
    expect(opencodeAgentPlugin.agents?.map((agent) => agent.id)).toEqual(["opencode"]);
  });

  // The desktop webview evaluates this bundle as a blob module, where a static
  // `node:` import fails to resolve and a module-scope `process` read throws —
  // either one drops the whole plugin and its agents vanish from the launcher
  // while the Bun sidecars keep listing them. Keep node-only work lazy.
  it.each(ENTRY_MODULES)("keeps %s free of module-scope node globals", (file) => {
    const source = readFileSync(join(sourceDir, file), "utf8");
    expect(source).not.toMatch(/^import .*"node:/m);
    expect(source).not.toMatch(/^\s*(?:const|let|var) .*\bprocess\./m);
  });
});
