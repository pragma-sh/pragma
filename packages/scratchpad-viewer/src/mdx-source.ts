/**
 * Removes frontmatter and import statements from scratchpad MDX before it is
 * evaluated in a web view.
 *
 * Frontmatter is host metadata the MDX compiler would reject without a plugin.
 * Imports are dropped because the document runs with no module resolver: the
 * components they name are supplied to MDX as run-time components instead, so a
 * document that imports from `@pragma/scratchpad/ui` renders exactly as it does
 * on the desktop, and one that imports a worktree file reports the missing
 * component in place rather than failing to render at all.
 */
export function prepareMdxSource(source: string): string {
  const withoutFrontmatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
  return withoutFrontmatter.replace(/^import\s+[^\n]*?(?:\n|$)/gm, "");
}
