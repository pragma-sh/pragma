import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const children = new Set<ChildProcessWithoutNullStreams>();

function waitForEvent(
  child: ChildProcessWithoutNullStreams,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => finish(new Error("timed out waiting for sidecar event")),
      10_000,
    );
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (predicate(event)) {
            finish(undefined, event);
            return;
          }
        } catch {
          // Ignore non-protocol output while waiting for the requested event.
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onExit = (code: number | null): void =>
      finish(new Error(`sidecar exited before event (code ${String(code)})`));
    const finish = (error?: Error, event?: Record<string, unknown>): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (event) resolve(event);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("sidecar did not exit after stdin EOF")),
      5_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

describe("automation sidecar lifecycle", () => {
  it("disposes loaded event listeners and exits when supervisor stdin closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-automations-eof-"));
    const sourcePath = join(root, "automation.ts");
    const disposedPath = join(root, "disposed");
    await writeFile(
      sourcePath,
      `import { writeFileSync } from "node:fs";
import { defineAutomation } from "@pragma/automations";
export default defineAutomation({
  name: "EOF cleanup",
  description: "verifies supervisor cleanup",
  trigger: {
    type: "event",
    listen() { return () => writeFileSync(${JSON.stringify(disposedPath)}, "yes"); },
  },
  run() {},
});
`,
    );
    const child = spawn(process.execPath, [join(packageRoot, "src/cli.ts")], {
      cwd: packageRoot,
      env: { ...process.env, PRAGMA_AUTOMATIONS_CACHE: join(root, "cache") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);

    try {
      await waitForEvent(child, (event) => event.type === "ready");
      const loaded = waitForEvent(
        child,
        (event) => event.type === "loaded" && event.id === "eof-test",
      );
      child.stdin.write(
        `${JSON.stringify({
          type: "load",
          id: "eof-test",
          path: sourcePath,
          root,
          scope: "local",
        })}\n`,
      );
      await loaded;
      const exited = waitForExit(child);
      child.stdin.end();

      expect(await exited).toBe(0);
      expect(await readFile(disposedPath, "utf8")).toBe("yes");
    } finally {
      children.delete(child);
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
