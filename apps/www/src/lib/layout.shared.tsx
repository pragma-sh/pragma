import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { appName, gitConfig } from "./shared";

/** Navigation options shared by the marketing layout and the docs layout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
