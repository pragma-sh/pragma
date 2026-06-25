import { afterEach, describe, expect, it } from "vitest";

import {
  addFixItComment,
  clearFixItComments,
  type FixItComment,
  getFixItComments,
  removeFixItComment,
} from "./fix-it-store";

const PR = 4242;

function comment(threadId: string): FixItComment {
  return { threadId, path: "f.ts", line: 1, body: "do the thing" };
}

afterEach(() => {
  clearFixItComments(PR);
});

describe("fix-it-store", () => {
  it("adds comments and exposes them per PR", () => {
    addFixItComment(PR, comment("a"));
    addFixItComment(PR, comment("b"));
    expect(getFixItComments(PR).map((entry) => entry.threadId)).toEqual(["a", "b"]);
  });

  it("ignores duplicate thread ids", () => {
    addFixItComment(PR, comment("a"));
    addFixItComment(PR, comment("a"));
    expect(getFixItComments(PR)).toHaveLength(1);
  });

  it("removes a single comment", () => {
    addFixItComment(PR, comment("a"));
    addFixItComment(PR, comment("b"));
    removeFixItComment(PR, "a");
    expect(getFixItComments(PR).map((entry) => entry.threadId)).toEqual(["b"]);
  });

  it("clears the whole list", () => {
    addFixItComment(PR, comment("a"));
    clearFixItComments(PR);
    expect(getFixItComments(PR)).toHaveLength(0);
  });

  it("returns a stable empty reference for an unflagged PR", () => {
    expect(getFixItComments(999)).toBe(getFixItComments(998));
  });
});
