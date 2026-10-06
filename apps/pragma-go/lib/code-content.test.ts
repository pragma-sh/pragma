import { describe, expect, it } from "vitest";

import { diffView, fileName, fileView, unavailableText } from "./code-content";

const file = (overrides: Partial<Parameters<typeof fileView>[0] & object> = {}) => ({
  path: "src/a.ts",
  text: "const a = 1;",
  binary: false,
  truncated: false,
  byteSize: 12,
  ...overrides,
});

describe("fileView", () => {
  it("renders text files and reports why others cannot be shown", () => {
    expect(fileView(file(), "src/a.ts").content).toEqual({
      kind: "file",
      path: "src/a.ts",
      text: "const a = 1;",
    });
    expect(fileView(file({ binary: true }), "x").unavailable).toEqual({ kind: "binary" });
    expect(fileView(file({ truncated: true, byteSize: 3 * 1024 * 1024 }), "x").unavailable).toEqual(
      { kind: "tooLarge", bytes: 3 * 1024 * 1024 },
    );
    expect(fileView(undefined, "x")).toEqual({ content: null, unavailable: null });
  });
});

describe("diffView", () => {
  it("renders text diffs and refuses binary ones", () => {
    const diff = { path: "a", oldText: "a", newText: "b", binary: false };
    expect(diffView(diff, "a").content).toEqual({
      kind: "diff",
      path: "a",
      oldText: "a",
      newText: "b",
    });
    expect(diffView({ ...diff, binary: true }, "a").unavailable).toEqual({ kind: "binary" });
  });
});

describe("labels", () => {
  it("words unavailability and names files", () => {
    expect(unavailableText({ kind: "tooLarge", bytes: 5 * 1024 * 1024 })).toContain("5.0 MB");
    expect(fileName("src/lib/a.ts")).toBe("a.ts");
    expect(fileName("README.md")).toBe("README.md");
  });
});
