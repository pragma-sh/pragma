import type { MetadataRoute } from "next";

import { COMPETITORS, compareDetailRoute } from "@/lib/compare-data";
import { loadOfficialPlugins, pluginDetailUrl } from "@/lib/plugins";
import { compareRoute, docsRoute, pluginsRoute, siteUrl } from "@/lib/shared";
import { source } from "@/lib/source";

/** Every public marketing, docs, and plugin-gallery URL — the deep-link forwarders are excluded as noindex. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [plugins, docsPages] = await Promise.all([
    loadOfficialPlugins(),
    Promise.resolve(source.getPages()),
  ]);

  const staticRoutes = ["/", pluginsRoute, compareRoute, docsRoute];
  const compareRoutes = COMPETITORS.map((competitor) => compareDetailRoute(competitor.slug));
  const pluginRoutes = plugins.map((plugin) => pluginDetailUrl(plugin.package));
  const docsRoutes = docsPages.map((page) => page.url);

  const urls = [...staticRoutes, ...compareRoutes, ...pluginRoutes, ...docsRoutes];

  return urls.map((url) => ({
    url: new URL(url, siteUrl).toString(),
    lastModified: new Date(),
  }));
}
