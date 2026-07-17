import type { UserConfig } from "vite";
import { describe, expect, it } from "vitest";

import config from "./vite.config";

describe("Vite config", () => {
  it("dedupes CodeMirror state without bypassing package resolution", () => {
    const resolve = (config as UserConfig).resolve;
    expect(resolve?.dedupe).toContain("@codemirror/state");
    expect(resolve?.alias).not.toHaveProperty("@codemirror/state");
  });
});
