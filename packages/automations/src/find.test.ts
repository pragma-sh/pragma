import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findFiles } from "./find.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pragma-find-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, contents = "x"): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

describe("findFiles", () => {
  it("finds a nested file by name", async () => {
    await write(join("src", "deep", "test.txt"));
    expect(await findFiles(root, ".", { name: "test.txt" })).toEqual([
      join("src", "deep", "test.txt"),
    ]);
  });

  it("skips generated directories, including .pragma worktrees", async () => {
    await write(join("node_modules", "pkg", "test.txt"));
    await write(join(".pragma", "worktrees", "abc", "test.txt"));
    await write(join("target", "test.txt"));
    await write("test.txt");
    expect(await findFiles(root, ".", { name: "test.txt" })).toEqual(["test.txt"]);
  });

  it("does not follow symlinked directories", async () => {
    await write(join("real", "test.txt"));
    await symlink(join(root, "real"), join(root, "link"), "dir");
    expect(await findFiles(root, ".", { name: "test.txt" })).toEqual([join("real", "test.txt")]);
  });

  it("filters by minimum size", async () => {
    await write("small.txt", "ab");
    await write("large.txt", "abcdefghij");
    expect(await findFiles(root, ".", { minBytes: 5 })).toEqual(["large.txt"]);
  });

  it("rejects a start path outside the root", async () => {
    await expect(findFiles(root, "..")).rejects.toThrow("path escapes automation root");
  });

  it("returns nothing for a missing path", async () => {
    expect(await findFiles(root, "missing")).toEqual([]);
  });
});
