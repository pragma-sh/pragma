import { describe, expect, it } from "bun:test";

import { blogDate, blogTagLabels, blogTags, publishedFirst } from "./blog-utils";

describe("blog", () => {
  it("features the newest dated post without changing source order", () => {
    const posts = [{ data: { date: "2026-09-10" } }, { data: { date: "2026-09-24" } }];
    expect(publishedFirst(posts)).toEqual([posts[1], posts[0]]);
    expect(posts[0]?.data.date).toBe("2026-09-10");
  });

  it("formats a publication date in UTC", () => {
    expect(blogDate("2026-09-24")).toBe("September 24, 2026");
  });

  it("labels every accepted tag", () => {
    expect(blogTags).toEqual(["release"]);
    expect(blogTagLabels.release).toBe("New release");
  });
});
