import type { MetadataRoute } from "next";

import { COMPETITORS, compareDetailRoute } from "@/lib/compare-data";
import { getBlogPosts } from "@/lib/blog";
import { loadOfficialPlugins, pluginDetailUrl } from "@/lib/plugins";
import {
  blogRoute,
  compareRoute,
  docsRoute,
  downloadsRoute,
  pluginsRoute,
  siteUrl,
} from "@/lib/shared";
import { source } from "@/lib/source";

/** Every public marketing, blog, docs, and plugin-gallery URL — excluding noindex forwarders. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [plugins, docsPages] = await Promise.all([
    loadOfficialPlugins(),
    Promise.resolve(source.getPages()),
  ]);

  const staticRoutes = ["/", downloadsRoute, pluginsRoute, compareRoute, docsRoute, blogRoute];
  const blogRoutes = getBlogPosts().map((post) => post.url);
  const compareRoutes = COMPETITORS.map((competitor) => compareDetailRoute(competitor.slug));
  const pluginRoutes = plugins.map((plugin) => pluginDetailUrl(plugin.package));
  const docsRoutes = docsPages.map((page) => page.url);

  const urls = [...staticRoutes, ...blogRoutes, ...compareRoutes, ...pluginRoutes, ...docsRoutes];

  return urls.map((url) => ({
    url: new URL(url, siteUrl).toString(),
    lastModified: new Date(),
  }));
}
