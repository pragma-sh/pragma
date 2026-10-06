import type { DirEntry } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import { ROOT_PATH, toggleExpanded, visibleFileRows, type DirListing } from "./file-tree";

const dir = (path: string): DirEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  isDir: true,
});
const file = (path: string): DirEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  isDir: false,
});

function listings(entries: Record<string, DirListing>): Map<string, DirListing> {
  return new Map(Object.entries(entries));
}

const labels = (rows: ReturnType<typeof visibleFileRows>) =>
  rows.map((row) =>
    row.kind === "entry" ? `${row.depth}:${row.entry.name}` : `${row.depth}:(${row.text})`,
  );

describe("visibleFileRows", () => {
  const tree = listings({
    [ROOT_PATH]: { kind: "ready", entries: [dir("src"), file("README.md")] },
    src: { kind: "ready", entries: [dir("src/lib"), file("src/main.ts")] },
    "src/lib": { kind: "ready", entries: [] },
  });

  it("shows only the root while nothing is expanded", () => {
    expect(labels(visibleFileRows(tree, new Set()))).toEqual(["0:src", "0:README.md"]);
  });

  it("nests expanded folders depth-first in host order", () => {
    expect(labels(visibleFileRows(tree, new Set(["src", "src/lib"])))).toEqual([
      "0:src",
      "1:lib",
      "2:(Empty)",
      "1:main.ts",
      "0:README.md",
    ]);
  });

  it("hides a cached subtree under a collapsed folder", () => {
    expect(labels(visibleFileRows(tree, new Set(["src/lib"])))).toEqual(["0:src", "0:README.md"]);
  });

  it("shows loading and errors in place of a listing", () => {
    expect(labels(visibleFileRows(new Map(), new Set()))).toEqual(["0:(Loading…)"]);
    const failed = listings({
      [ROOT_PATH]: { kind: "ready", entries: [dir("secret")] },
      secret: { kind: "error", message: "Permission denied" },
    });
    expect(labels(visibleFileRows(failed, new Set(["secret"])))).toEqual([
      "0:secret",
      "1:(Permission denied)",
    ]);
  });
});

describe("toggleExpanded", () => {
  it("adds and removes without mutating the input", () => {
    const start = new Set(["a"]);
    expect([...toggleExpanded(start, "b")]).toEqual(["a", "b"]);
    expect([...toggleExpanded(start, "a")]).toEqual([]);
    expect([...start]).toEqual(["a"]);
  });
});
