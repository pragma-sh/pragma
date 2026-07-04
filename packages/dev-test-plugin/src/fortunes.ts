/** A small rotation of dev fortunes shown by the Fortune sidebar tab. */
export const FORTUNES: readonly string[] = [
  "The pragma you compile is the pragma you keep.",
  "Commit early, commit often, but never commit secrets.",
  "A worktree a day keeps the merge conflicts away.",
  "Render output bypasses React state for a reason.",
  "When in doubt, route through the owning host.",
  "Lint is non-negotiable; so is the formatter.",
  "Shared values belong in @pragma/constants.",
];

/**
 * Picks a random fortune using `rng` (defaults to {@link Math.random}).
 * Pure and injectable so tests can pin the choice deterministically.
 */
export function pickFortune(rng: () => number = Math.random): string {
  const index = Math.floor(rng() * FORTUNES.length);
  const fallback = FORTUNES[0];
  return (FORTUNES[index] ?? fallback) as string;
}
