import values from "../values.json";
import type { Welcome } from "./generated/constants";

const welcome = values.welcome as Welcome;

/** A filled heading, split so the location can be rendered as its own element. */
export interface WelcomeHeadingParts {
  /** Text before the location. */
  before: string;
  /** The highlighted `PROJECT/WORKTREE` path. */
  location: string;
  /** Text after the location. */
  after: string;
}

/** Which wording a surface needs: one that names a location, or one that cannot. */
export type WelcomeHeadingKind = "located" | "generic";

/** Builds the `PROJECT/WORKTREE` location label, dropping either missing half. */
export function welcomeLocation(
  projectName: string | null | undefined,
  worktreeName: string | null | undefined,
): string {
  return [projectName, worktreeName].filter((part): part is string => Boolean(part)).join("/");
}

/**
 * Picks a heading variation. `random` is injectable so tests can pin the choice;
 * callers should pick once per mount, since the heading does not cycle.
 */
export function pickWelcomeHeading(
  kind: WelcomeHeadingKind,
  random: () => number = Math.random,
): string {
  const headings = welcome[kind];
  const index = Math.floor(random() * headings.length);
  return headings[index] ?? headings[0] ?? "";
}

/**
 * Fills a located heading and splits it around the location. Returns null when
 * there is no location to name, so the caller can fall back to a generic
 * heading instead of rendering a half-written sentence.
 */
export function formatWelcomeHeading(
  heading: string,
  location: string,
): WelcomeHeadingParts | null {
  if (!location) {
    return null;
  }
  const [before = "", after = ""] = heading.split(welcome.locationPlaceholder);
  return { before, location, after };
}

/** Flattens split heading parts back into a plain sentence. */
export function welcomeHeadingText(parts: WelcomeHeadingParts): string {
  return `${parts.before}${parts.location}${parts.after}`;
}
