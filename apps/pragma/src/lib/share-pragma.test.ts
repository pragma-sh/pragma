import { describe, expect, it } from "vitest";

import {
  PRAGMA_REPO,
  PRAGMA_SHARE_TEXT,
  PRAGMA_SHARE_TITLE,
  PRAGMA_SITE_URL,
  pragmaShareTargets,
} from "@/lib/share-pragma";

function target(id: string): URL {
  const found = pragmaShareTargets().find((entry) => entry.id === id);
  if (!found) throw new Error(`missing share target ${id}`);
  return new URL(found.url);
}

describe("pragmaShareTargets", () => {
  it("prefills the X composer with the message and site link", () => {
    const url = target("x");
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe(PRAGMA_SHARE_TEXT);
    expect(url.searchParams.get("url")).toBe(PRAGMA_SITE_URL);
  });

  it("submits the site to Hacker News and Reddit with a title", () => {
    expect(target("hackernews").searchParams.get("u")).toBe(PRAGMA_SITE_URL);
    expect(target("hackernews").searchParams.get("t")).toBe(PRAGMA_SHARE_TITLE);
    expect(target("reddit").searchParams.get("url")).toBe(PRAGMA_SITE_URL);
    expect(target("reddit").searchParams.get("title")).toBe(PRAGMA_SHARE_TITLE);
  });

  it("puts the link inside the Bluesky text, which has no url field", () => {
    expect(target("bluesky").searchParams.get("text")).toContain(PRAGMA_SITE_URL);
  });
});

describe("PRAGMA_REPO", () => {
  it("is parsed from the GitHub homepage URL", () => {
    expect(PRAGMA_REPO).toEqual({ owner: "pragma-sh", repo: "pragma" });
  });
});
