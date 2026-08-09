import type { DragEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginPathDrag,
  endPathDrag,
  isPathDragActive,
  PRAGMA_PATHS_MIME,
  readDraggedPaths,
} from "./file-drag";

/** A dataTransfer stub that only serves the MIME types it was given. */
function dragEvent(data: Record<string, string>): DragEvent<HTMLElement> {
  return {
    dataTransfer: {
      getData: (type: string) => data[type] ?? "",
      setData: vi.fn((type: string, value: string) => {
        data[type] = value;
      }),
      effectAllowed: "",
    },
  } as unknown as DragEvent<HTMLElement>;
}

beforeEach(endPathDrag);

describe("path drags", () => {
  it("writes the payload to both the custom type and text/plain", () => {
    const data: Record<string, string> = {};
    beginPathDrag(dragEvent(data), ["src/app.ts"]);

    expect(JSON.parse(data[PRAGMA_PATHS_MIME]!)).toEqual(["src/app.ts"]);
    expect(JSON.parse(data["text/plain"]!)).toEqual(["src/app.ts"]);
  });

  it("tracks whether a drag is in flight", () => {
    expect(isPathDragActive()).toBe(false);
    beginPathDrag(dragEvent({}), ["a.ts"]);
    expect(isPathDragActive()).toBe(true);
    endPathDrag();
    expect(isPathDragActive()).toBe(false);
  });

  it("reads paths from the custom type", () => {
    const paths = readDraggedPaths(dragEvent({ [PRAGMA_PATHS_MIME]: '["a.ts"]' }));
    expect(paths).toEqual(["a.ts"]);
  });

  it("falls back to text/plain when the custom type is empty", () => {
    const paths = readDraggedPaths(dragEvent({ "text/plain": '["a.ts","b.ts"]' }));
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("falls back to the in-flight drag when the webview serves no data at all", () => {
    beginPathDrag(dragEvent({}), ["src/app.ts"]);
    expect(readDraggedPaths(dragEvent({}))).toEqual(["src/app.ts"]);
  });

  it("returns null for an outside drag carrying unrelated text", () => {
    expect(readDraggedPaths(dragEvent({ "text/plain": "hello" }))).toBeNull();
  });

  it("rejects a text/plain payload that is not an array of strings", () => {
    expect(readDraggedPaths(dragEvent({ "text/plain": '{"path":"a.ts"}' }))).toBeNull();
    expect(readDraggedPaths(dragEvent({ "text/plain": "[1,2]" }))).toBeNull();
  });
});
