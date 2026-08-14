/**
 * Viewport widths at which the shell sheds chrome, in px.
 *
 * Frontend-only: nothing in Rust reads these, so they live here rather than in
 * `@pragma/constants`. They are ordered so the panes disappear one at a time —
 * the right sidebar (the widest, at a 360px minimum) goes first, and the
 * project sidebar only follows once the centre pane would otherwise be
 * unusable.
 *
 * Both sit below the 1024px default window width (`tauri.conf.json`), so a
 * freshly-launched window still opens with both sidebars showing.
 */
export const layoutBreakpoints = {
  /** Below this, the right sidebar auto-collapses to its rail. */
  rightSidebar: 1000,
  /** Below this, the project sidebar auto-collapses to its rail too. */
  leftSidebar: 760,
} as const;
