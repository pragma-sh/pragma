import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { readStdinLines } from "./index.ts";

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
});
