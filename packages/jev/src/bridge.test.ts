import { describe, expect, it } from "vitest";

import { chooseInstance, parseToken, type DevInstance } from "./bridge.ts";

const instance = (pid: number, exe: string | null, uptimeMs = 1000): DevInstance => ({
  pid,
  port: 4000 + pid,
  token: "t",
  exe,
  uptimeMs,
});

describe("parseToken", () => {
  it("accepts a bridge token and rejects anything else", () => {
    expect(parseToken('{"port":1,"token":"x","pid":2}')).toEqual({ port: 1, token: "x", pid: 2 });
    expect(parseToken('{"port":"1"}')).toBeNull();
    expect(parseToken("not json")).toBeNull();
  });
});

describe("chooseInstance", () => {
  const mine = instance(1, "/work/tree-a/target/debug/pragma");
  const theirs = instance(2, "/work/tree-b/target/debug/pragma");
  const otherApp = instance(3, "/elsewhere/target/debug/some-other-tauri-app");

  it("prefers the instance built from the current checkout", () => {
    expect(chooseInstance([theirs, mine], { checkout: "/work/tree-a" }).pid).toBe(1);
  });

  it("honours an explicit pid and fails on an unknown one", () => {
    expect(chooseInstance([mine, theirs], { pid: 2 }).pid).toBe(2);
    expect(() => chooseInstance([mine], { pid: 9 })).toThrow(/pid 9/);
  });

  it("falls back to a lone instance but refuses to guess between several", () => {
    expect(chooseInstance([theirs], { checkout: "/work/tree-a" }).pid).toBe(2);
    expect(() => chooseInstance([mine, theirs], { checkout: "/nowhere" })).toThrow(/--pid/);
  });

  it("ignores Tauri apps that are not Pragma", () => {
    expect(() => chooseInstance([otherApp], {})).toThrow(/bun run dev/);
  });
});
