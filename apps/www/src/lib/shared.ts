/** Product name shown in navigation, metadata, and OG images. */
export const appName = "Pragma";

/** One-line product description used for default metadata. */
export const appDescription =
  "Pragma is a desktop workspace for running persistent, worktree-scoped coding agents.";

/** Absolute site origin, used to resolve OG image URLs. Override per deployment. */
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** Base route the documentation is served from. */
export const docsRoute = "/docs";
export const downloadsRoute = "/downloads";
export const pluginsRoute = "/plugins";
export const compareRoute = "/compare";
export const blogRoute = "/blog";

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

/** Public source repository. */
export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** Latest desktop release and platform-specific downloads. */
export const downloadUrl = `${repoUrl}/releases/latest`;

/**
 * Pragma Go on the App Store. The listing is named "Pragma Sh Go" because App Store
 * names are globally unique (see `apps/pragma-go/AGENTS.md`); the app is Pragma Go.
 */
export const appStoreUrl = "https://apps.apple.com/us/app/pragma-sh-go/id6804842149";

/** Docs section walking through installing the Pragma Go APK with Obtainium. */
export const androidInstallRoute = `${docsRoute}/user-guide/mobile#android-with-obtainium`;
