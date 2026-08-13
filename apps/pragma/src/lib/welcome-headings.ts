/**
 * Heading copy for the no-tabs welcome screen. Frontend-only, so it lives here
 * rather than in `@pragma/constants` (nothing in Rust renders it).
 */

/**
 * The heading variations; one is picked at random per welcome screen. Each
 * carries a `{location}` placeholder, split out so the rendered heading can
 * highlight the project/worktree path.
 */
export const WELCOME_HEADINGS: readonly [string, ...string[]] = [
  "What should we build in {location}?",
  "What are we going to ship in {location}?",
  "What will we create in {location}?",
  "What should we make next in {location}?",
  "Ready when you are — what should we build in {location}?",
];

/** A filled heading, split so the location can be rendered as its own element. */
export interface WelcomeHeadingParts {
  /** Text before the location. */
  before: string;
  /** The highlighted `PROJECT/WORKTREE` path. */
  location: string;
  /** Text after the location. */
  after: string;
}

/** Builds the `PROJECT/WORKTREE` location label, dropping either missing half. */
export function welcomeLocation(
  projectName: string | null | undefined,
  worktreeName: string | null | undefined,
): string {
  return [projectName, worktreeName].filter((part): part is string => Boolean(part)).join("/");
}

/** Picks a heading variation at random (once per mount — the heading does not cycle). */
export function pickWelcomeHeading(): string {
  const index = Math.floor(Math.random() * WELCOME_HEADINGS.length);
  return WELCOME_HEADINGS[index] ?? WELCOME_HEADINGS[0];
}

/**
 * Fills a heading variation and splits it around the location. Returns null when
 * there is no location to name, so the caller can render a generic heading
 * instead of a half-written sentence.
 */
export function formatWelcomeHeading(
  heading: string,
  location: string,
): WelcomeHeadingParts | null {
  if (!location) {
    return null;
  }
  const [before = "", after = ""] = heading.split("{location}");
  return { before, location, after };
}

/** Flattens split heading parts back into a plain sentence. */
export function welcomeHeadingText(parts: WelcomeHeadingParts): string {
  return `${parts.before}${parts.location}${parts.after}`;
}
