# Pull-request assets

Images referenced from pull-request bodies Pragma opens (the "Created with Pragma"
footer built in `apps/pragma/src/lib/pr-signature.ts`).

These live at the repository root, outside every package, because their **raw URL on
`main` is part of a published contract**: it is baked into pull-request bodies that
already exist in other people's repositories. Moving or renaming a file here breaks the
image in every PR ever opened by Pragma, so treat the paths as append-only.

| File                | Used by                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `open-worktree.svg` | `constants.github.prSignature.badgeUrl` — the footer's action button |

Notes:

- **The badge has to be hosted.** GitHub's markdown sanitizer drops `data:` URIs, so the
  button cannot be inlined into the PR body; it is fetched (through GitHub's camo proxy)
  from `raw.githubusercontent.com` on `main`.
- **One fixed color.** The button is painted in the shipped `--primary`
  (`oklch(0.52 0.16 252)` = `#0069c1`) with `--primary-foreground` (`#fcfcfc`) text. It
  does not follow a user's `.pragma/theme.json`: a file committed to `main` is the same
  for everyone who views the PR.
- **Hand-written SVG, no build step.** Edit the file directly and keep it self-contained
  — no external fonts, no scripts, no references outside the document.
