import { describe, expect, it } from "bun:test";

import { blogFeed } from "./blog-feed";

const channel = {
  title: "Pragma Blog",
  description: "Notes & updates",
  siteUrl: "https://pragma.sh",
  blogPath: "/blog",
  feedPath: "/blog/rss.xml",
};

describe("blogFeed", () => {
  it("emits absolute links, RFC 822 dates, and tag categories", () => {
    const feed = blogFeed(channel, [
      {
        url: "/blog/pragma-1-2",
        data: { title: "Pragma 1.2", description: "Agents", date: "2026-10-03", tags: ["release"] },
      },
    ]);
    expect(feed).toContain("<link>https://pragma.sh/blog</link>");
    expect(feed).toContain('<guid isPermaLink="true">https://pragma.sh/blog/pragma-1-2</guid>');
    expect(feed).toContain("<pubDate>Sat, 03 Oct 2026 00:00:00 GMT</pubDate>");
    expect(feed).toContain("<lastBuildDate>Sat, 03 Oct 2026 00:00:00 GMT</lastBuildDate>");
    expect(feed).toContain("<category>New release</category>");
    expect(feed).toContain('href="https://pragma.sh/blog/rss.xml" rel="self"');
  });

  it("escapes XML in post text", () => {
    const feed = blogFeed(channel, [
      {
        url: "/blog/a",
        data: { title: 'Fix <b> & "quotes"', description: "it's", date: "2026-01-01", tags: [] },
      },
    ]);
    expect(feed).toContain("<title>Fix &lt;b&gt; &amp; &quot;quotes&quot;</title>");
    expect(feed).toContain("<description>it&apos;s</description>");
    expect(feed).toContain("<description>Notes &amp; updates</description>");
  });

  it("omits lastBuildDate when there are no posts", () => {
    expect(blogFeed(channel, [])).not.toContain("lastBuildDate");
  });
});
