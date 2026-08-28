import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { appName, docsRoute, gitConfig, pluginsRoute } from "./shared";

/** Navigation options shared by the marketing layout and the docs layout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      { text: "Plugins", url: pluginsRoute, active: "nested-url" },
      { text: "Docs", url: docsRoute, active: "nested-url" },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
