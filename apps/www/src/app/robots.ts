import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/shared";

/** Everything is public marketing/docs content except the deep-link forwarders, which are noindex on the page itself. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
