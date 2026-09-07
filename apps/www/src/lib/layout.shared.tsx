import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { BrandIcon } from "@/components/brand-icon";

import { appName, compareRoute, docsRoute, pluginsRoute, repoUrl } from "./shared";

/** Navigation options shared by the marketing layout and the docs layout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <BrandIcon className="size-6" />
          <span className="font-semibold">{appName}</span>
        </>
      ),
    },
    links: [
      { text: "Plugins", url: pluginsRoute, active: "nested-url" },
      { text: "Compare", url: compareRoute, active: "nested-url" },
      { text: "Docs", url: docsRoute, active: "nested-url" },
    ],
    githubUrl: repoUrl,
  };
}
