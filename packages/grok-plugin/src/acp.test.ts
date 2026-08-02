import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PluginContext } from "@pragma/plugin/catalog";
import { afterEach, describe, expect, it } from "vitest";

import { readGrokAcp } from "./acp";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe.runIf(process.platform !== "win32")("readGrokAcp", () => {
  it("closes stdin as soon as both responses arrive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pragma-grok-acp-"));
    tempDirs.push(dir);
    const grok = join(dir, "grok");
    writeFileSync(
      grok,
      `#!/bin/sh
IFS= read -r _
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
IFS= read -r _
printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"subscription_tier":"Free"}}'
while IFS= read -r _; do :; done
`,
    );
    chmodSync(grok, 0o755);

    const ctx = {
      project: { path: dir },
      sdk: {
        exec: {
          run: async ({ cwd, commands }: { cwd: string; commands: string[] }) => {
            const command = commands[0] ?? "";
            const started = performance.now();
            const { stdout, stderr } = await execFileAsync(
              process.env.SHELL ?? "/bin/sh",
              ["-c", command],
              {
                cwd,
                env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
                timeout: 2_000,
              },
            );
            return [
              { command, stdout, stderr, status: 0, durationMs: performance.now() - started },
            ];
          },
        },
      },
    } as unknown as PluginContext;

    await expect(readGrokAcp(ctx)).resolves.toEqual({
      missing: false,
      initialize: { ok: true, result: { protocolVersion: 1 } },
      billing: { ok: true, result: { subscription_tier: "Free" } },
    });
  });
});
