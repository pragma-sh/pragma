import { afterEach, describe, expect, test } from "bun:test";

import { GET } from "../app/download/[target]/route";
import {
  archFromUserAgent,
  defaultTarget,
  detectPlatform,
  DOWNLOAD_TARGETS,
  findInstallerUrl,
  isDownloadTarget,
  resetDownloadCache,
  type DownloadTarget,
} from "./downloads";
import { downloadUrl } from "./shared";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDownloadCache();
});

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  windowsArm:
    "Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
};

/** Every installer name a release uploads, as `release.yml` writes them. */
function releaseAssets(version: string) {
  return (Object.keys(DOWNLOAD_TARGETS) as DownloadTarget[]).flatMap((target) => {
    const name = `Pragma-${version}-${target}.${DOWNLOAD_TARGETS[target].extension}`;
    return [
      { name, browser_download_url: `https://dl.example/${name}` },
      { name: `${name}.sig`, browser_download_url: `https://dl.example/${name}.sig` },
    ];
  });
}

describe("detectPlatform", () => {
  test("recognises each desktop OS", () => {
    expect(detectPlatform({ userAgent: UA.mac })).toBe("macos");
    expect(detectPlatform({ userAgent: UA.windows })).toBe("windows");
    expect(detectPlatform({ userAgent: UA.linux })).toBe("linux");
  });

  test("prefers the reported platform over the user agent", () => {
    expect(detectPlatform({ userAgent: UA.linux, platform: "Windows" })).toBe("windows");
  });

  test("sends phones, tablets and ChromeOS to the release page", () => {
    expect(detectPlatform({ userAgent: UA.android, platform: "Android" })).toBeNull();
    expect(detectPlatform({ userAgent: UA.iphone })).toBeNull();
    expect(detectPlatform({ userAgent: UA.chromebook })).toBeNull();
    // iPadOS Safari presents a Mac user agent; touch points give it away.
    expect(detectPlatform({ userAgent: UA.mac, maxTouchPoints: 5 })).toBeNull();
  });
});

describe("defaultTarget", () => {
  test("macOS assumes Apple silicon unless told otherwise", () => {
    expect(defaultTarget("macos", archFromUserAgent(UA.mac))).toBe("darwin-aarch64");
    expect(defaultTarget("macos", "arm")).toBe("darwin-aarch64");
    expect(defaultTarget("macos", "x86")).toBe("darwin-x86_64");
  });

  test("Linux follows the CPU and defaults to .deb", () => {
    expect(defaultTarget("linux", archFromUserAgent(UA.linux))).toBe("linux-x86_64-deb");
    expect(defaultTarget("linux", archFromUserAgent(UA.linuxArm))).toBe("linux-aarch64-deb");
  });

  test("reads Chromium's bare architecture hints", () => {
    expect(archFromUserAgent("arm")).toBe("arm");
    expect(archFromUserAgent("x86")).toBe("x86");
    expect(archFromUserAgent("")).toBeNull();
  });

  test("Windows follows the CPU architecture", () => {
    expect(defaultTarget("windows", archFromUserAgent(UA.windows))).toBe("windows-x86_64");
    expect(defaultTarget("windows", archFromUserAgent(UA.windowsArm))).toBe("windows-aarch64");
  });
});

describe("findInstallerUrl", () => {
  test("matches each target to its own installer, not its signature", () => {
    const assets = releaseAssets("1.0.0");
    for (const target of Object.keys(DOWNLOAD_TARGETS) as DownloadTarget[]) {
      const url = findInstallerUrl(assets, target);
      expect(url).toBe(
        `https://dl.example/Pragma-1.0.0-${target}.${DOWNLOAD_TARGETS[target].extension}`,
      );
    }
  });

  test("tolerates a pre-release version with its own dashes", () => {
    expect(findInstallerUrl(releaseAssets("1.1.0-rc.1"), "darwin-x86_64")).toBe(
      "https://dl.example/Pragma-1.1.0-rc.1-darwin-x86_64.dmg",
    );
  });

  test("is null when the release lacks that installer", () => {
    expect(findInstallerUrl([], "windows-x86_64")).toBeNull();
  });
});

function call(target: string) {
  return GET(new Request(`https://pragma.test/download/${target}`), {
    params: Promise.resolve({ target }),
  });
}

describe("GET /download/[target]", () => {
  test("redirects to the latest release's installer", async () => {
    globalThis.fetch = (async () =>
      Response.json({ assets: releaseAssets("1.0.0") })) as unknown as typeof fetch;
    const res = await call("windows-x86_64");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://dl.example/Pragma-1.0.0-windows-x86_64.exe");
  });

  test("falls back to the release page for an unknown target", async () => {
    const res = await call("../../etc");
    expect(res.headers.get("location")).toBe(downloadUrl);
    expect(isDownloadTarget("toString")).toBe(false);
  });

  test("falls back to the release page when GitHub fails", async () => {
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    expect((await call("darwin-aarch64")).headers.get("location")).toBe(downloadUrl);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await call("darwin-aarch64")).headers.get("location")).toBe(downloadUrl);
  });
});
