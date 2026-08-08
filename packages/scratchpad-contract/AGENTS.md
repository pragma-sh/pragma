# packages/scratchpad-contract — @pragma/scratchpad-contract

The **scratchpad file contract**: the managed frontmatter of a `.mdx` scratchpad
(id, title, agent attachment), and the sibling `<file>.mdx.comments.json` thread.
Pure data — no React, no renderer, no transport. Its only dependency is
`@pragma/constants` (the frontmatter key and contract version).

Everything that reads or writes those two files goes through here: the desktop
editor, `@pragma/sdk`'s `client.scratchpads`, `@pragma/scratchpad-viewer`, and
the mobile client. **Never re-implement frontmatter parsing or comment
serialization** — a second copy of either is how the clients drift apart and a
comment written on a phone stops showing up in the desktop's handoff.

## Rules

- **This package exists to break a dependency cycle, and must stay able to.**
  The contract used to live in `@pragma/scratchpad-viewer`, which depends on
  `@pragma/scratchpad`, which depends on `@pragma/sdk` — so the SDK could not
  import it without a cycle (turbo rejects the graph outright). Keep this
  package free of every workspace dependency except `@pragma/constants`.
- **Ships a built `dist/`, like `@pragma/sdk` and `@pragma/plugin` — not raw
  `src/index.ts` like `@pragma/constants`.** `bun run build` (`bunup … --dts`)
  runs via turbo's `^build` dependency before any consumer builds. This is a
  workaround for a Bun/Windows crash (`panic: Expected pretty file path to
have only forward slashes`, a long-standing unfixed upstream bug —
  oven-sh/bun#14843, #14972, #15007, #15421) that `bunup --dts` hit only for
  this package's _two-hop_ workspace-symlink chain (`@pragma/sdk` →
  `@pragma/scratchpad-contract` → `@pragma/constants`) once this package was
  extracted; `@pragma/constants` itself (one hop, still raw `src/index.ts`)
  never triggered it. If you see that panic again on a Windows build, suspect
  the same class of fix before anything else.
- **`from`/`to` are ProseMirror positions, and only the desktop can compute
  them.** Any other client writes `0`/`0` and anchors by `quote` +
  `blockIndex`; `createScratchpadComment` is the only supported way to build one.
- **A malformed comment loses one comment, not the file.**
  `parseScratchpadComments` drops entries that fail the shape guard instead of
  throwing, because the alternative costs a user every other comment they wrote.
  Frontmatter is the opposite: `parseScratchpadDocument` rejects a file without
  managed metadata (or with an unknown `version`) rather than guessing.
- **`unresolvedCommentsPrompt` is the agent handoff wording.** Desktop and
  mobile both send it, so changing the text changes what every agent receives.
