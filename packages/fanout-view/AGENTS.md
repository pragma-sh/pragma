# `@pragma-sh/fanout-view`

The client-side view model over the host's fanouts, shared by the desktop
(`apps/pragma`) and Pragma Go (`apps/pragma-go`). Source-only and private: both
apps import `src/index.ts` directly.

## What belongs here, and what does not

- **Here:** anything both clients must agree on about _presenting_ a fanout —
  which worktrees are attempts of an active fanout (and so are grouped, not
  listed), member labels, status wording, whether actions may be offered
  (`canActOnFanout` mirrors the host's own gate), pairing scratchpads across
  attempts, and collapsing an attempt's change sections into one row per path.
- **Not here:** layout (the desktop's comparison column model stays in
  `apps/pragma/src/lib/fanout.ts`), React bindings, styling, or anything that
  talks to the host. Fanout _rules_ — selectors, branch naming, status roll-up —
  live on the host in `crates/pragma-core/src/fanout.rs`.
- **No `Array.prototype.toSorted`.** Pragma Go runs this on Hermes, which does
  not provide it yet; sort a fresh copy instead.
- The wire types (`Fanout`, `FanoutMember`, `WorktreeChanges`, …) live in
  `@pragma-sh/constants`; this package only reads them.
