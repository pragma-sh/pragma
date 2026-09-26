import { describe, expect, it } from "vitest";

import {
  forgetHost,
  parseSavedHosts,
  rememberHost,
  savedHostLabel,
  type SavedHost,
} from "./saved-hosts";

function host(url: string, over: Partial<SavedHost> = {}): SavedHost {
  return { config: { url, token: `token-${url}` }, hostName: null, lastConnectedAt: 1, ...over };
}

describe("parseSavedHosts", () => {
  it("returns an empty list for missing or corrupt storage", () => {
    expect(parseSavedHosts(null)).toEqual([]);
    expect(parseSavedHosts("not json")).toEqual([]);
    expect(parseSavedHosts('{"url":"x"}')).toEqual([]);
  });

  it("keeps only well-formed entries", () => {
    const good = host("https://a.example", { hostName: "Desk" });
    const raw = JSON.stringify([good, { config: { url: "https://b.example" } }, null]);
    expect(parseSavedHosts(raw)).toEqual([good]);
  });
});

describe("rememberHost", () => {
  it("puts the newest connection first without duplicating the URL", () => {
    const hosts = [host("https://a.example"), host("https://b.example")];
    const next = rememberHost(hosts, { url: "https://b.example", token: "new" }, "B", 9);
    expect(next.map((entry) => entry.config.url)).toEqual([
      "https://b.example",
      "https://a.example",
    ]);
    expect(next[0]).toEqual({
      config: { url: "https://b.example", token: "new" },
      hostName: "B",
      lastConnectedAt: 9,
    });
  });

  it("keeps a remembered name when the reconnect learned none", () => {
    const hosts = [host("https://a.example", { hostName: "Desk" })];
    const next = rememberHost(hosts, { url: "https://a.example", token: "t" }, null, 2);
    expect(next[0]?.hostName).toBe("Desk");
  });

  it("drops the oldest hosts past the cap", () => {
    let hosts: SavedHost[] = [];
    for (let index = 0; index < 10; index += 1) {
      hosts = rememberHost(hosts, { url: `https://${index}.example`, token: "t" }, null, index);
    }
    expect(hosts).toHaveLength(6);
    expect(hosts[0]?.config.url).toBe("https://9.example");
    expect(hosts.at(-1)?.config.url).toBe("https://4.example");
  });
});

describe("forgetHost", () => {
  it("removes only the matching URL", () => {
    const hosts = [host("https://a.example"), host("https://b.example")];
    expect(forgetHost(hosts, "https://a.example")).toEqual([host("https://b.example")]);
  });
});

describe("savedHostLabel", () => {
  it("prefers the host name and falls back to the bare URL", () => {
    expect(savedHostLabel(host("https://a.example", { hostName: "Desk" }))).toBe("Desk");
    expect(savedHostLabel(host("https://a.example"))).toBe("a.example");
  });
});

describe("savedHostLabel with a path", () => {
  it("shows only the host for a URL with a path and query", () => {
    const pathHost: SavedHost = {
      config: { url: "https://box.ngrok.app:8443/base/path?x=1", token: "t" },
      hostName: null,
      lastConnectedAt: 1,
    };
    expect(savedHostLabel(pathHost)).toBe("box.ngrok.app:8443");
  });
});
