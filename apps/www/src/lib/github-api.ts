import { gitConfig } from "./shared";

/** REST base for the public repository, for server-side GitHub API reads. */
export const repoApiUrl = `https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}`;

/**
 * Headers for a server-side GitHub API read. Sends `GITHUB_TOKEN` (or `GH_TOKEN`) when
 * set, because unauthenticated GitHub allows 60 requests an hour per IP, shared across
 * every serverless instance.
 */
export function githubHeaders(userAgent: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": userAgent,
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
