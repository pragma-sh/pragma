import { describe, expect, it } from "vitest";

import {
  dropRevocations,
  livePendingRevocations,
  parsePendingRevocations,
  queueRevocation,
  REVOCATION_TTL_MS,
  type PendingRevocation,
} from "./pending-revocation";

const host = { url: "https://host.example", token: "token-1" };
const other = { url: "https://other.example", token: "token-2" };

function entry(url: string, queuedAt: number): PendingRevocation {
  return { config: { url, token: `token-${url}` }, queuedAt };
}

describe("parsePendingRevocations", () => {
  it("reads back what was stored", () => {
    const pending = [entry(host.url, 10)];
    expect(parsePendingRevocations(JSON.stringify(pending))).toEqual(pending);
  });

  it("yields nothing for missing or corrupt storage", () => {
    expect(parsePendingRevocations(null)).toEqual([]);
    expect(parsePendingRevocations("not json")).toEqual([]);
    expect(parsePendingRevocations('{"url":"x"}')).toEqual([]);
  });

  it("skips entries missing the credentials a retry needs", () => {
    const raw = JSON.stringify([
      { config: { url: host.url }, queuedAt: 1 },
      { config: host, queuedAt: "soon" },
      { config: host, queuedAt: 1 },
    ]);
    expect(parsePendingRevocations(raw)).toEqual([{ config: host, queuedAt: 1 }]);
  });
});

describe("queueRevocation", () => {
  it("keeps the credentials needed to retry", () => {
    expect(queueRevocation([], host, 100)).toEqual([{ config: host, queuedAt: 100 }]);
  });

  it("replaces an earlier revocation for the same host", () => {
    const pending = queueRevocation([{ config: host, queuedAt: 1 }], host, 100);
    expect(pending).toEqual([{ config: host, queuedAt: 100 }]);
  });

  it("keeps other hosts queued", () => {
    const pending = queueRevocation([{ config: other, queuedAt: 1 }], host, 100);
    expect(pending.map((item) => item.config.url)).toEqual([other.url, host.url]);
  });

  it("prunes expired credentials as it queues", () => {
    const stale = entry("https://stale.example", 0);
    const pending = queueRevocation([stale], host, REVOCATION_TTL_MS + 1);
    expect(pending.map((item) => item.config.url)).toEqual([host.url]);
  });

  it("caps the queue at the most recent hosts", () => {
    const older = Array.from({ length: 5 }, (_, index) => entry(`https://h${index}.example`, 1));
    const pending = queueRevocation(older, host, 2);
    expect(pending).toHaveLength(5);
    expect(pending.at(-1)?.config.url).toBe(host.url);
    expect(pending.at(0)?.config.url).toBe("https://h1.example");
  });
});

describe("livePendingRevocations", () => {
  it("drops only credentials past the TTL", () => {
    const pending = [entry(host.url, 0), entry(other.url, 10)];
    expect(livePendingRevocations(pending, REVOCATION_TTL_MS + 5)).toEqual([entry(other.url, 10)]);
  });
});

describe("dropRevocations", () => {
  it("forgets one host and leaves the rest", () => {
    const pending = [entry(host.url, 1), entry(other.url, 2)];
    expect(dropRevocations(pending, host.url)).toEqual([entry(other.url, 2)]);
  });
});
