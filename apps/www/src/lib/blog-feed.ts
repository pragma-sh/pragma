import { blogTagLabels, type BlogTag } from "./blog-utils";

/** The fields of a published post that its feed entry needs. */
export interface FeedPost {
  url: string;
  data: {
    title: string;
    description: string;
    date: string;
    tags: BlogTag[];
  };
}

/** Channel-level details for the blog feed. */
export interface FeedChannel {
  title: string;
  description: string;
  /** Absolute site origin that every relative post URL resolves against. */
  siteUrl: string;
  /** Site-relative path of the blog index. */
  blogPath: string;
  /** Site-relative path the feed itself is served from. */
  feedPath: string;
}

const xmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => xmlEntities[char] ?? char);
}

/** RFC 822 date (what RSS 2.0 requires) for a `YYYY-MM-DD` publication date, at UTC midnight. */
function rssDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

function feedItem(post: FeedPost, siteUrl: string): string {
  const link = escapeXml(new URL(post.url, siteUrl).toString());
  const categories = post.data.tags.map(
    (tag) => `      <category>${escapeXml(blogTagLabels[tag])}</category>`,
  );
  return [
    "    <item>",
    `      <title>${escapeXml(post.data.title)}</title>`,
    `      <link>${link}</link>`,
    `      <guid isPermaLink="true">${link}</guid>`,
    `      <pubDate>${rssDate(post.data.date)}</pubDate>`,
    `      <description>${escapeXml(post.data.description)}</description>`,
    ...categories,
    "    </item>",
  ].join("\n");
}

/** RSS 2.0 document for the given posts, in the order given (newest first). */
export function blogFeed(channel: FeedChannel, posts: FeedPost[]): string {
  const blogUrl = escapeXml(new URL(channel.blogPath, channel.siteUrl).toString());
  const feedUrl = escapeXml(new URL(channel.feedPath, channel.siteUrl).toString());
  const latest = posts[0];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${blogUrl}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    "    <language>en-us</language>",
    `    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />`,
    ...(latest ? [`    <lastBuildDate>${rssDate(latest.data.date)}</lastBuildDate>`] : []),
    ...posts.map((post) => feedItem(post, channel.siteUrl)),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
