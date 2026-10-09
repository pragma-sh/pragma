import { getBlogPosts } from "@/lib/blog";
import { blogFeed } from "@/lib/blog-feed";
import { appName, blogDescription, blogFeedRoute, blogRoute, siteUrl } from "@/lib/shared";

export const revalidate = false;

/** RSS 2.0 feed of every published post, newest first. */
export function GET() {
  const feed = blogFeed(
    {
      title: `${appName} Blog`,
      description: blogDescription,
      siteUrl,
      blogPath: blogRoute,
      feedPath: blogFeedRoute,
    },
    getBlogPosts(),
  );

  return new Response(feed, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
