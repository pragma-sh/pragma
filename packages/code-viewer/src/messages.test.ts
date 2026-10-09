import { describe, expect, it } from "vitest";

import { parseCodeViewerMessage } from "./messages";

describe("parseCodeViewerMessage", () => {
  it("parses the renderer's reports", () => {
    expect(parseCodeViewerMessage('{"type":"ready","lines":12}')).toEqual({
      type: "ready",
      lines: 12,
    });
    expect(parseCodeViewerMessage('{"type":"error","message":"no"}')).toEqual({
      type: "error",
      message: "no",
    });
  });

  it("drops malformed and unknown payloads", () => {
    expect(parseCodeViewerMessage("not json")).toBeNull();
    expect(parseCodeViewerMessage('{"type":"ready"}')).toBeNull();
    expect(parseCodeViewerMessage('{"type":"navigate","url":"x"}')).toBeNull();
  });
});
