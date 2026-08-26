import { afterEach, describe, expect, test } from "bun:test";

import { GET } from "../app/api/updates/route";
import {
  DEV_UI_OVERLAY,
  evaluateUpdate,
  evaluateUpdates,
  loadGithubManifests,
  type ReleaseManifest,
} from "./updates";

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

  test("is silent when the release has no asset for this platform", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        apply: "restart",
        components: { ...manifest({}).components, app: "0.0.1" },
      }),
      platform: "linux-aarch64-rpm",
      running,
    });
    expect(result).toEqual({ available: false });
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

  test("does not offer a signed older release as a downgrade", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        components: { ...manifest({}).components, ui: "0.0.1" },
        assets: { ui: { url: "https://example.com/ui", sha256: "abc", signature: "sig" } },
      }),
      platform: "darwin-aarch64",
      running: { ...running, ui: "0.0.2" },
    });
    expect(result).toEqual({ available: false });
  });

  test("does not offer a UI overlay when native components are behind", () => {
    const result = evaluateUpdate({
      manifest: manifest({
        components: {
          ui: "0.0.2",
          app: "0.0.1",
          "pragma-server": "0.0.1",
          "pragma-protocol": "0.0.0",
        },
        assets: { ui: { url: "https://example.com/ui", sha256: "abc", signature: "sig" } },
      }),
      platform: "darwin-aarch64",
      running,
    });
    expect(result).toEqual({ available: false });
  });

  test("falls back to prior restart release when native components are behind", () => {
    const reload = manifest({
      components: {
        ui: "0.0.2",
        app: "0.0.1",
        "pragma-server": "0.0.1",
        "pragma-protocol": "0.0.0",
      },
      assets: { ui: { url: "https://example.com/ui", sha256: "abc", signature: "sig" } },
    });
    const restart = manifest({
      apply: "restart",
      components: {
        ui: "0.0.1",
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
    });
    const result = evaluateUpdates({
      documents: [{ manifest: reload }, { manifest: restart }],
      platform: "darwin-aarch64",
      running,
    });
    expect(result.apply).toBe("restart");
    expect(result.asset?.url).toBe("https://example.com/Pragma.dmg");
  });
});

test("development overlay is a tar archive containing index.html", () => {
  expect(new TextDecoder().decode(DEV_UI_OVERLAY.subarray(0, 10))).toBe("index.html");
  expect(new TextDecoder().decode(DEV_UI_OVERLAY.subarray(257, 262))).toBe("ustar");
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

describe("loadGithubManifests", () => {
  test("returns null when the latest release cannot be loaded", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

    expect(await loadGithubManifests(1)).toEqual([]);
  });

  test("loads and caches the release manifest", async () => {
    const releaseManifest = manifest({});
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls += 1;
      if (calls === 1) {
        return Response.json([
          { assets: [{ name: "other.zip", browser_download_url: "https://example.com/other" }] },
          {
            assets: [
              { name: "release.json", browser_download_url: "https://example.com/release.json" },
              {
                name: "release.json.sig",
                browser_download_url: "https://example.com/release.json.sig",
              },
            ],
          },
        ]);
      }
      if (String(input).endsWith(".sig")) return new Response("manifest-signature\n");
      return new Response(`${JSON.stringify(releaseManifest)}\n`);
    }) as typeof fetch;

    expect(await loadGithubManifests(10)).toEqual([
      {
        manifest: releaseManifest,
        manifestJson: `${JSON.stringify(releaseManifest)}\n`,
        manifestSignature: "manifest-signature",
      },
    ]);
    expect(await loadGithubManifests(11)).toHaveLength(1);
    expect(calls).toBe(3);
  });
});
