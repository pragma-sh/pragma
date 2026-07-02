import { describe, expect, it } from "vitest";

import { ndjsonStream } from "./streaming";

describe("streaming", () => {
  it("parses split NDJSON chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}\n{"'));
        controller.enqueue(new TextEncoder().encode('b":2}\n'));
        controller.close();
      },
    });

    const values = [];
    for await (const value of ndjsonStream<{ a?: number; b?: number }>(new Response(stream))) {
      values.push(value);
    }

    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
