import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

let junieHome: string;

afterEach(() => {
  if (junieHome) {
    rmSync(junieHome, { recursive: true, force: true });
  }
});

/** Installs the hooks into a fresh JUNIE_HOME and returns the parsed config. */
function install(existingConfig?: Record<string, unknown>): Record<string, unknown> {
  junieHome = mkdtempSync(join(tmpdir(), "pragma-junie-install-"));
  if (existingConfig) {
    writeFileSync(join(junieHome, "config.json"), `${JSON.stringify(existingConfig, null, 2)}\n`);
  }
  execFileSync("bun", ["run", "scripts/install-local.ts"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, JUNIE_HOME: junieHome },
    encoding: "utf8",
  });
  return JSON.parse(readFileSync(join(junieHome, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function hookCommands(config: Record<string, unknown>): string[] {
  const hooks = config.hooks as Record<string, unknown>;
  return Object.values(hooks).flatMap((groups) => {
    const entries = groups as Array<{ hooks?: Array<{ command?: string }> }>;
    return entries.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ""));
  });
}

describe("install-local", () => {
  it("installs the hook bridge into an empty Junie config", () => {
    const config = install();
    const commands = hookCommands(config);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(join(PACKAGE_ROOT, "hooks", "report.sh"));
    }
  });

  it("replaces a previous install from a different checkout instead of stacking", () => {
    const previous = join("/Users/other/checkout", "packages", "junie-plugin");
    const oldCommand = `sh "${previous}/hooks/report.sh" cleared`;
    const config = install({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: oldCommand, timeout: 10 }] }],
      },
    });
    const commands = hookCommands(config);
    expect(commands.some((command) => command.includes("junie-plugin/hooks/report.sh"))).toBe(true);
    // The previous checkout's SessionStart hook was replaced, not stacked.
    const sessionStart = (
      config.hooks as { SessionStart: Array<{ hooks?: Array<{ command?: string }> }> }
    ).SessionStart.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ""));
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]).not.toContain(previous);
    expect(sessionStart[0]).toContain(join(PACKAGE_ROOT, "hooks", "report.sh"));
  });

  it("preserves hooks contributed by other tools", () => {
    const foreign = "sh /some/other/tool/hook.sh event";
    const config = install({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: foreign, timeout: 5 }] }],
      },
    });
    const commands = hookCommands(config);
    expect(commands).toContain(foreign);
  });
});
