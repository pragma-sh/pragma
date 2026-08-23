import { afterEach, describe, expect, test } from "bun:test";

import { GET } from "../app/api/updates/route";
import { evaluateUpdate, loadGithubManifest, type ReleaseManifest } from "./updates";

const running = { ui: "0.0.0", app: "0.0.0", server: "0.0.0", protocol: "0.0.0" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe("update endpoint", () => {
  test("qualifies fixture asset URLs against the request origin", async () => {
    const response = await GET(
      new Request(
        "https://pragma.test/api/updates?platform=darwin-aarch64&ui=0.0.0&app=0.0.0&server=0.0.0&protocol=0.0.0",
      ),
    );

    expect(await response.json()).toMatchObject({
      available: true,
      asset: { url: "https://pragma.test/api/updates/asset" },
    });
  });
});

describe("loadGithubManifest", () => {
  test("returns null when the latest release cannot be loaded", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

    expect(await loadGithubManifest(1)).toBeNull();
  });

  test("loads and caches the release manifest", async () => {
    const releaseManifest = manifest({});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          assets: [
            { name: "release.json", browser_download_url: "https://example.com/release.json" },
          ],
        });
      }
      return Response.json(releaseManifest);
    }) as typeof fetch;

    expect(await loadGithubManifest(10)).toEqual(releaseManifest);
    expect(await loadGithubManifest(11)).toEqual(releaseManifest);
    expect(calls).toBe(2);
  });
});
