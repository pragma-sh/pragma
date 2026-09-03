import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { BrandFavicon } from "@/components/brand-favicon";

import { appName, docsRoute, pluginsRoute, repoUrl } from "./shared";

/** Navigation options shared by the marketing layout and the docs layout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <BrandFavicon className="size-6" />
          <span className="font-semibold">{appName}</span>
        </>
      ),
    },
    links: [
      { text: "Plugins", url: pluginsRoute, active: "nested-url" },
      { text: "Docs", url: docsRoute, active: "nested-url" },
    ],
    githubUrl: repoUrl,
  };
}
