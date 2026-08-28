/** Product name shown in navigation, metadata, and OG images. */
export const appName = "Pragma";

/** One-line product description used for default metadata. */
export const appDescription =
  "Pragma is a desktop workspace for running persistent, worktree-scoped coding agents.";

/** Absolute site origin, used to resolve OG image URLs. Override per deployment. */
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** Base route the documentation is served from. */
export const docsRoute = "/docs";
export const pluginsRoute = "/plugins";

/** Base route for generated per-page OG images. */
export const docsImageRoute = "/og/docs";

/** Base route serving the raw markdown of a docs page (for LLMs and copy buttons). */
export const docsContentRoute = "/llms.mdx/docs";

/** GitHub repository the docs link back to. */
export const gitConfig = {
  user: "pragma-sh",
  repo: "pragma",
  branch: "main",
};
