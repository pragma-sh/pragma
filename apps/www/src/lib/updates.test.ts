import { describe, expect, test } from "bun:test";

import { evaluateUpdate, type ReleaseManifest } from "./updates";

const running = { ui: "0.0.0", app: "0.0.0", server: "0.0.0", protocol: "0.0.0" };

function manifest(overrides: Partial<ReleaseManifest>): ReleaseManifest {
  return {
    schemaVersion: 1,
    releasedAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc",
    apply: "reload",
    notes: "notes",
    changelogUrl: "https://example.com/changelog",
    components: {
      ui: "0.0.0",
      app: "0.0.0",
      "pragma-server": "0.0.0",
      "pragma-protocol": "0.0.0",
    },
    assets: {},
    ...overrides,
  };
}

describe("evaluateUpdate", () => {
  test("offers a reload from the manifest when the running UI is behind", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        apply: "reload",
        components: {
          ui: "0.0.1",
          app: "0.0.0",
          "pragma-server": "0.0.0",
          "pragma-protocol": "0.0.0",
        },
        assets: {
          ui: { url: "https://example.com/ui", sha256: "abc", signature: "sig" },
        },
      }),
      platform: "darwin-aarch64",
      running,
    });
    expect(result.available).toBe(true);
    expect(result.apply).toBe("reload");
    expect(result.version).toBe("0.0.1");
    expect(result.asset?.url).toBe("https://example.com/ui");
  });

  test("offers the platform installer when the manifest apply mode is restart", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        apply: "restart",
        components: {
          ui: "0.0.0",
          app: "0.0.1",
          "pragma-server": "0.0.1",
          "pragma-protocol": "0.0.0",
        },
        assets: {
          "darwin-aarch64": {
            url: "https://example.com/Pragma.dmg",
            sha256: "def",
            signature: "sig",
          },
        },
      }),
      platform: "darwin-aarch64",
      running,
    });
    expect(result.available).toBe(true);
    expect(result.apply).toBe("restart");
    expect(result.asset?.url).toBe("https://example.com/Pragma.dmg");
  });

  test("is silent when every shipped component already matches", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        apply: "reload",
        components: {
          ui: "0.0.0",
          app: "0.0.0",
          "pragma-server": "0.0.0",
          "pragma-protocol": "0.0.0",
        },
      }),
      platform: "darwin-aarch64",
      running,
    });
    expect(result).toEqual({ available: false });
  });
});
