// Drives the real `agy-plugin/hooks/report.sh` (and the built `dist/hook.mjs`
// behind it) through `sh`, with a fake `pragma-cli` that records its argv.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

const PLUGIN = resolve(import.meta.dirname, "..", "agy-plugin");
const SCRIPT = join(PLUGIN, "hooks", "report.sh");
const BUILT = existsSync(join(PLUGIN, "dist", "hook.mjs"));

let work: string;
let log: string;
let fakeCli: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "agy-report-"));
  log = join(work, "calls.log");
  fakeCli = join(work, "pragma-cli");
  writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(fakeCli, 0o755);
});

function hook(event: string, payload: unknown, env: Record<string, string> = {}) {
  const result = spawnSync("sh", [SCRIPT, event], {
    cwd: PLUGIN,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: work,
      PRAGMA_TAB_ID: "tab-1",
      PRAGMA_CLI: fakeCli,
      ...env,
    },
  });
  return { stdout: result.stdout, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

const inPragma = { PRAGMA_SERVER_SOCKET: "/tmp/fake.sock" };

describe("report.sh", () => {
  test("PreToolUse always answers `ask` (an empty answer would deny the tool)", () => {
    expect(hook("PreToolUse", {}).stdout.trim()).toBe('{"decision":"ask"}');
    expect(hook("PreToolUse", {}, inPragma).stdout.trim()).toBe('{"decision":"ask"}');
    // Even with no Node or Bun on PATH, where the bundled reporter cannot run.
    expect(hook("PreToolUse", {}, { ...inPragma, PATH: "/usr/bin:/bin" }).stdout.trim()).toBe(
      '{"decision":"ask"}',
    );
  });

  test("other events answer an empty object", () => {
    expect(hook("Stop", {}).stdout.trim()).toBe("{}");
  });

  test("outside Pragma nothing is reported", () => {
    hook("PreInvocation", { conversationId: "c", lastUserInput: "hi", invocationNum: 0 });
    expect(existsSync(log)).toBe(false);
  });

  test.skipIf(!BUILT)("inside Pragma a turn reports started and stopped", () => {
    const base = { conversationId: "conv", lastUserInput: "hi" };
    hook("PreInvocation", { ...base, invocationNum: 0 }, inPragma);
    const { calls } = hook("Stop", { ...base, terminationReason: "NO_TOOL_CALL" }, inPragma);
    const reports = calls
      .split("\n")
      .filter((line) => line.startsWith("agent report"))
      .map((line) => line.replace("agent report --agent antigravity ", ""));
    expect(reports).toEqual([
      "session-id --id conv",
      "started",
      "session-name --name hi",
      "stopped",
    ]);
  });
});
