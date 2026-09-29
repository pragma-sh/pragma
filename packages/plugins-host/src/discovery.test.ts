import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverSlashCommands, type MarkdownSource } from "@pragma-sh/plugin/catalog";
import type { PluginContext } from "@pragma-sh/plugin";

/** Runs the discovery script through a real POSIX shell, as `sdk.exec.run` would. */
function shellContext(root: string): PluginContext {
  return {
    project: { id: "p", name: "p", path: root },
    sdk: {
      exec: {
        run: async ({ commands, cwd }: { commands: string[]; cwd: string }) => [
          {
            status: 0,
            stderr: "",
            stdout: execFileSync("/bin/sh", ["-c", commands[0]!], { cwd }).toString(),
          },
        ],
      },
    },
  } as unknown as PluginContext;
}

describe("markdown slash-command discovery", () => {
  it("scans command files and skills through a real shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "pragma-discovery-"));
    mkdirSync(join(root, ".claude/commands/frontend"), { recursive: true });
    writeFileSync(
      join(root, ".claude/commands/frontend/component.md"),
      "---\ndescription: Make a component\nargument-hint: <name>\n---\n",
    );
    writeFileSync(join(root, ".claude/commands/ship.md"), "Ship it");
    mkdirSync(join(root, "skills/deploy"), { recursive: true });
    writeFileSync(join(root, "skills/deploy/SKILL.md"), "---\nname: deploy-app\n---\n");
    mkdirSync(join(root, "skills/hidden"), { recursive: true });
    writeFileSync(join(root, "skills/hidden/SKILL.md"), "---\nuser-invocable: false\n---\n");
    const sources: MarkdownSource[] = [
      { dir: ".claude/commands", layout: "files" },
      { dir: "skills", layout: "skills", prefix: "skill:" },
      { dir: "missing", layout: "files" },
    ];
    expect(await discoverSlashCommands(shellContext(root), sources)).toEqual([
      { name: "frontend:component", description: "Make a component", argumentHint: "<name>" },
      { name: "ship" },
      { name: "skill:deploy-app" },
    ]);
  });
});
