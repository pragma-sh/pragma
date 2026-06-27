import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPORT_SH = fileURLToPath(new URL("../hooks/report.sh", import.meta.url));
const TAB_ID = "tab-test";

let workdir: string;
let binDir: string;
let tmpEnvDir: string;
let logPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "pragma-cursor-hook-"));
  binDir = join(workdir, "bin");
  tmpEnvDir = join(workdir, "tmp");
  logPath = join(workdir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpEnvDir, { recursive: true });
  const fake = join(binDir, "pragma-cli");
  writeFileSync(fake, `#!/usr/bin/env sh\necho "$*" >> "$PRAGMA_TEST_LOG"\n`, { mode: 0o755 });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function markerPath(): string {
  return join(tmpEnvDir, `pragma-cli-cursor-${TAB_ID}.active`);
}

function run(event: string, { socket = true }: { socket?: boolean } = {}): string[] {
  const runEnv: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpEnvDir,
    PRAGMA_TAB_ID: TAB_ID,
    PRAGMA_TEST_LOG: logPath,
  };
  if (socket) {
    runEnv.PRAGMA_DAEMON_SOCKET = join(workdir, "daemon.sock");
  }
  execFileSync("sh", [REPORT_SH, event], { env: runEnv });
  return calls();
}

function calls(): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

describe("cursor report.sh", () => {
  it("no-ops outside Pragma", () => {
    run("started", { socket: false });
    expect(calls()).toEqual([]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports started and sets marker", () => {
    run("started");
    expect(calls()).toEqual(["--agent cursor report started"]);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("reports stopped and clears marker", () => {
    run("started");
    run("stopped");
    expect(calls()).toEqual(["--agent cursor report started", "--agent cursor report stopped"]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports cleared", () => {
    run("started");
    run("cleared");
    expect(calls()).toEqual(["--agent cursor report started", "--agent cursor report cleared"]);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("reports command attention only during a turn", () => {
    run("attention-command");
    expect(calls()).toEqual([]);
    run("started");
    run("attention-command");
    expect(calls()).toEqual([
      "--agent cursor report started",
      "--agent cursor report attention --kind command",
    ]);
  });

  it("re-asserts running after attention via running", () => {
    run("started");
    run("attention-command");
    run("running");
    expect(calls()).toEqual([
      "--agent cursor report started",
      "--agent cursor report attention --kind command",
      "--agent cursor report started",
    ]);
  });
});
