import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { freshImportSpecifier, readStdinLines } from "./index.ts";

describe("readStdinLines", () => {
  it("emits trimmed, non-empty lines split on newlines across chunks", () => {
    const stdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    try {
      const lines: string[] = [];
      readStdinLines((line) => lines.push(line));

      stdin.write('{"a":1}\n  \n{"b":2}\n{"c"');
      stdin.write(":3}\n");

      expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });

  it("notifies the sidecar exactly once when supervisor stdin closes", async () => {
    const stdin = new PassThrough();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    try {
      let ends = 0;
      const ended = new Promise<void>((resolve) => {
        readStdinLines(
          () => undefined,
          () => {
            ends += 1;
            resolve();
          },
        );
      });

      stdin.end();
      await ended;
      stdin.emit("close");

      expect(ends).toBe(1);
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });
});

describe("freshImportSpecifier", () => {
  it("re-imports a rewritten file once its version changes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sidecar-kit-")), "bundle.mjs");
    writeFileSync(path, 'export default "v1";');
    const first = (await import(freshImportSpecifier(path, 1))) as { default: string };
    writeFileSync(path, 'export default "v2";');
    const same = (await import(freshImportSpecifier(path, 1))) as { default: string };
    const fresh = (await import(freshImportSpecifier(path, 2))) as { default: string };
    expect([first.default, same.default, fresh.default]).toEqual(["v1", "v1", "v2"]);
  });
});
