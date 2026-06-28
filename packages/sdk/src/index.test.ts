import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reportAttention, reportCleared, reportStarted, reportStopped } from "./index";
import type { PragmaCliError } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  tempDirs.length = 0;
});

describe("pragma-cli sdk", () => {
  it("runs report started with the typed agent flag", async () => {
    const { argsFile, executable } = await createArgCaptureExecutable();

    const result = await reportStarted({
      agent: "mock",
      executable,
      env: { PRAGMA_SDK_ARGS_FILE: argsFile },
    });

    await expect(readArgs(argsFile)).resolves.toEqual(["--agent", "mock", "report", "started"]);
    expect(result.stdout).toBe("ok");
  });

  it("runs report stopped with the optional worktree id flag", async () => {
    const { argsFile, executable } = await createArgCaptureExecutable();

    await reportStopped({
      agent: "mock",
      executable,
      env: { PRAGMA_SDK_ARGS_FILE: argsFile },
      worktreeId: "worktree-1",
    });

    await expect(readArgs(argsFile)).resolves.toEqual([
      "--agent",
      "mock",
      "report",
      "stopped",
      "--worktree-id",
      "worktree-1",
    ]);
  });

  it("runs report attention with the typed kind flag", async () => {
    const { argsFile, executable } = await createArgCaptureExecutable();

    await reportAttention({
      agent: "mock",
      executable,
      env: { PRAGMA_SDK_ARGS_FILE: argsFile },
      kind: "question",
    });

    await expect(readArgs(argsFile)).resolves.toEqual([
      "--agent",
      "mock",
      "report",
      "attention",
      "--kind",
      "question",
    ]);
  });

  it("runs report cleared with the optional worktree id flag", async () => {
    const { argsFile, executable } = await createArgCaptureExecutable();

    await reportCleared({
      agent: "mock",
      executable,
      env: { PRAGMA_SDK_ARGS_FILE: argsFile },
      worktreeId: "worktree-1",
    });

    await expect(readArgs(argsFile)).resolves.toEqual([
      "--agent",
      "mock",
      "report",
      "cleared",
      "--worktree-id",
      "worktree-1",
    ]);
  });

  it("rejects with captured stderr when the cli fails", async () => {
    const executable = await createExecutable("fail", "#!/bin/sh\nprintf 'nope' >&2\nexit 7\n");

    await expect(reportStarted({ agent: "mock", executable })).rejects.toMatchObject({
      args: ["--agent", "mock", "report", "started"],
      exitCode: 7,
      stderr: "nope",
    } satisfies Partial<PragmaCliError>);
  });

  it("uses PRAGMA_CLI from the merged environment when no executable is passed", async () => {
    const { argsFile, executable } = await createArgCaptureExecutable();

    await reportStarted({
      agent: "mock",
      env: { PRAGMA_CLI: executable, PRAGMA_SDK_ARGS_FILE: argsFile },
    });

    await expect(readArgs(argsFile)).resolves.toEqual(["--agent", "mock", "report", "started"]);
  });
});

async function createArgCaptureExecutable(): Promise<{ argsFile: string; executable: string }> {
  const dir = await createTempDir();
  const argsFile = join(dir, "args.txt");
  const executable = await createExecutable(
    "capture",
    "#!/bin/sh\nprintf '%s\n' \"$@\" > \"$PRAGMA_SDK_ARGS_FILE\"\nprintf 'ok'\n",
    dir,
  );
  return { argsFile, executable };
}

async function createExecutable(
  name: string,
  content: string,
  existingDir?: string,
): Promise<string> {
  const dir = existingDir ?? (await createTempDir());
  const executable = join(dir, name);
  await writeFile(executable, content);
  await chmod(executable, 0o755);
  return executable;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pragma-sdk-"));
  tempDirs.push(dir);
  return dir;
}

async function readArgs(argsFile: string): Promise<string[]> {
  const contents = await readFile(argsFile, "utf8");
  return contents.trimEnd().split("\n");
}
