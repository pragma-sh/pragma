import { constants } from "@pragma-sh/constants";

/** The page a share points people at. */
export const PRAGMA_SITE_URL = "https://pragma-app.sh";

/** Owner/repo of Pragma's own GitHub repository, parsed from its homepage URL. */
export const PRAGMA_REPO = repoFromUrl(constants.github.homepageUrl);

/** Short title for link aggregators (Hacker News, Reddit). */
export const PRAGMA_SHARE_TITLE =
  "Pragma: a desktop workspace for running persistent, worktree-scoped coding agents";

/** Prefilled post body for networks that take free text (X, Bluesky). */
export const PRAGMA_SHARE_TEXT =
  "I've been using Pragma to run coding agents side by side, each in its own worktree. Worth a look:";

/** A network Pragma can be shared to, and the prefilled URL that opens its composer. */
export interface ShareTarget {
  id: "x" | "hackernews" | "reddit" | "linkedin" | "bluesky";
  label: string;
  url: string;
}

/** Every share target, each a URL that opens that network's composer prefilled. */
export function pragmaShareTargets(): ShareTarget[] {
  const url = PRAGMA_SITE_URL;
  return [
    {
      id: "x",
      label: "X",
      url: withQuery("https://x.com/intent/post", { text: PRAGMA_SHARE_TEXT, url }),
    },
    {
      id: "hackernews",
      label: "Hacker News",
      url: withQuery("https://news.ycombinator.com/submitlink", { u: url, t: PRAGMA_SHARE_TITLE }),
    },
    {
      id: "reddit",
      label: "Reddit",
      url: withQuery("https://www.reddit.com/submit", { url, title: PRAGMA_SHARE_TITLE }),
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      url: withQuery("https://www.linkedin.com/sharing/share-offsite/", { url }),
    },
    {
      id: "bluesky",
      label: "Bluesky",
      url: withQuery("https://bsky.app/intent/compose", { text: `${PRAGMA_SHARE_TEXT} ${url}` }),
    },
  ];
}

function withQuery(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

function repoFromUrl(url: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = new URL(url).pathname.split("/").filter(Boolean);
  return { owner, repo };
}
