import { describe, expect, test } from "bun:test";

import { validateManifest, type PluginManifest } from "./shared";

const validManifest: PluginManifest = {
  name: "Plugin",
  description: "Description",
  install: { command: "node" },
};

describe("validateManifest", () => {
  test.each([
    [{ name: "" }, "fixture: name and description are required"],
    [
      { install: { command: "node scripts/install.mjs" } },
      "fixture: install.command must be a bare executable name",
    ],
    [{ categories: ["unknown"] }, "fixture: invalid category"],
    [
      { images: [{ url: "http://example.com/image.png", alt: "Image" }] },
      "fixture: images require HTTPS URLs and alt text",
    ],
    [{ categories: ["agent-plugin"] }, "fixture: agent-plugin category requires agentBinary"],
  ] satisfies Array<[Partial<PluginManifest>, string]>)(
    "rejects invalid metadata %#",
    (overrides, message) => {
      expect(() => validateManifest({ ...validManifest, ...overrides }, "fixture")).toThrow(
        message,
      );
    },
  );
});
