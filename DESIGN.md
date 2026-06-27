---
version: "alpha"
name: Pragma
description: >-
  Agent-agnostic AI coding-agent orchestration for macOS and Linux. A quiet,
  dark-first, native desktop surface in the spirit of the Codex app: layered
  neutral charcoals, a single restrained blue accent, system UI type, a
  monospace code voice, and hairline structure. Built on Tauri + React + shadcn.
colors:
  # --- Surfaces (dark is canonical; light variant documented in prose) ---
  background: "oklch(0.17 0.006 256)"        # app canvas, deepest layer
  surface: "oklch(0.20 0.006 256)"           # window / panel background
  elevated: "oklch(0.23 0.007 256)"          # cards, popovers, menus
  sidebar: "oklch(0.15 0.006 256)"           # Arc-spaces rail (often translucent)
  overlay: "oklch(0.12 0.006 256 / 0.62)"    # modal scrim
  # --- Text ---
  foreground: "oklch(0.93 0.004 256)"        # primary ink
  subtle: "oklch(0.70 0.009 256)"            # secondary / metadata text
  muted: "oklch(0.26 0.007 256)"             # muted fill (hover rows, chips)
  # --- Lines & focus ---
  border: "oklch(0.28 0.008 256)"            # hairline separators
  input: "oklch(0.31 0.008 256)"             # control borders
  ring: "oklch(0.62 0.15 252)"               # focus ring (accent)
  selection: "oklch(0.58 0.15 252 / 0.32)"   # text/selection highlight
  # --- Accent (the single driver of interaction) ---
  primary: "oklch(0.56 0.15 252)"            # Codex blue
  on-primary: "oklch(0.99 0 0)"
  primary-hover: "oklch(0.52 0.17 252)"
  # --- Semantic (mirrors codex semanticColors) ---
  success: "oklch(0.78 0.13 152)"            # diff added
  on-success: "oklch(0.20 0.03 152)"
  destructive: "oklch(0.64 0.19 18)"         # diff removed
  on-destructive: "oklch(0.16 0.04 18)"
  warning: "oklch(0.80 0.12 78)"             # attention / permission prompts
  on-warning: "oklch(0.22 0.03 78)"
  skill: "oklch(0.74 0.08 330)"              # agent/skill annotations
  on-skill: "oklch(0.18 0.02 330)"
typography:
  display:
    fontFamily: "-apple-system, 'SF Pro Display', system-ui, sans-serif"
    fontSize: 1.875rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  h1:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.015em
  h2:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  h3:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 1.0625rem
    fontWeight: 600
    lineHeight: 1.35
  body-md:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 0.8125rem
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif"
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.01em
  code:
    fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'liga' 0, 'calt' 0"
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: 30px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: 30px
  button-secondary-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.subtle}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: 30px
  input-chrome:
    backgroundColor: "{colors.input}"
  focus-ring:
    backgroundColor: "{colors.ring}"
  text-selection:
    backgroundColor: "{colors.selection}"
  card:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: 16px
  popover:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: 6px
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.subtle}"
    padding: 8px
  divider:
    backgroundColor: "{colors.border}"
  modal-overlay:
    backgroundColor: "{colors.overlay}"
  sidebar-item-active:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.subtle}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  tab-active:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.foreground}"
  badge-skill:
    backgroundColor: "{colors.skill}"
    textColor: "{colors.on-skill}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-attention:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-warning}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  diff-added:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-success}"
  diff-removed:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
---

## Overview

Pragma should feel like a tool that was already installed on the machine — a
native macOS/Linux app, not a website in a window. The reference is the **Codex
app**: dark-first, low-chrome, layered neutral charcoals, one disciplined blue
accent, system UI type for the shell and a monospace voice wherever code or
agent output lives. Structure is carried by **hairline borders and elevation**,
not by color or heavy shadow. The interface stays quiet so that the moving
parts — agents, diffs, terminals, the Arc-spaces project rail — are the only
things that draw the eye.

Two surfaces deserve special discipline because they are Pragma's identity: the
**spatial project rail** (horizontal Arc-spaces navigation with nestable
branches) and the **agent-assisted PR-review loop**. Both should read as calm
and legible at a glance; saturation is reserved for state (added/removed,
attention, skill), never for decoration.

Dark is the canonical theme and the values in the front matter describe it. A
light variant exists and is documented under each section and shipped in the
companion `globals.css`; it is a faithful inversion, not a different identity.

## Colors

A near-monochrome charcoal foundation with a single blue accent. Everything that
isn't text or state lives on the neutral ramp.

- **background `oklch(0.17 0.006 256)`** — the deepest canvas; the empty space behind panels.
- **surface `oklch(0.20 0.006 256)`** — default panel/window background.
- **elevated `oklch(0.23 0.007 256)`** — cards, popovers, menus, the active tab. One step up from surface.
- **sidebar `oklch(0.15 0.006 256)`** — the project rail; one step *down*, often rendered translucent over the desktop (vibrancy on macOS).
- **foreground `oklch(0.93 0.004 256)`** — primary ink. Soft white, never `#fff`.
- **subtle `oklch(0.70 0.009 256)`** — metadata, captions, inactive tabs, secondary labels.
- **border `oklch(0.28 0.008 256)`** — hairline separators; the primary structural device.
- **primary `oklch(0.56 0.15 252)`** — Codex blue. The *only* interactive accent: selected state, focus ring, primary action, links.

Semantic colors mirror the Codex `semanticColors` channel and are used **only**
to communicate state:

- **success `oklch(0.78 0.13 152)`** — diff added, passing checks, merged.
- **destructive `oklch(0.64 0.19 18)`** — diff removed, failing checks, destructive actions.
- **warning `oklch(0.80 0.12 78)`** — agent attention: permission / question / error prompts.
- **skill `oklch(0.74 0.08 330)`** — agent and skill annotations (e.g. "AI blame", trajectory tags).

**Light variant.** Invert the ramp: `background oklch(0.99 0.002 256)`,
`surface oklch(1 0 0)`, `elevated oklch(1 0 0)` with a hairline, `foreground
oklch(0.22 0.01 256)`, `border oklch(0.92 0.004 256)`, and a slightly darker
`primary oklch(0.52 0.16 252)` so the accent holds contrast on white.

## Typography

Two voices only. The **system UI face** (`-apple-system` / SF Pro on macOS,
the platform UI font on Linux) carries the entire shell — it's what makes the
app read as native. The **monospace face** (`SF Mono`, falling back to
JetBrains Mono / Fira Code) carries everything that is, or describes, code:
terminal output, diffs, file paths, branch names, commit SHAs, agent logs.
Ligatures are disabled in code contexts so columns and SHAs stay honest.

The scale is dense, the way native desktop apps are: body text is `14px`
(`0.875rem`), dropping to `13px` in lists and side panels. Headings use tight
negative tracking and weight 600 rather than larger sizes — restraint over
scale. Don't introduce a third family or a display serif; the personality here
is precision, not flourish.

## Layout

A **4px base unit**; spacing steps are `4 · 8 · 12 · 16 · 24 · 32 · 48`. Native
desktop density means default gaps and paddings stay small — toolbars and rows
breathe at `8–12px`, not `16–24px`. The frame is a classic desktop split:
translucent project rail on the left, a content pane that hosts per-branch tabs
(terminal · agent · browser), and contextual panels (diff, PR review) that slide
in from the right rather than stacking modally.

Prefer real desktop affordances over web patterns: sidebars, toolbars, menus,
keyboard shortcuts, and system materials. Layout should survive resizing down to
a narrow window without reflowing into a mobile column.

## Elevation & Depth

Depth is communicated with **hairline borders first, subtle shadow second** —
never with strong drop shadows or glows. The layering order from back to front
is `sidebar → background → surface → elevated → popover/overlay`, each step a
small lightness increase (≈ +0.03 L) plus, for floating layers, a soft low-alpha
shadow. On macOS, lean on native vibrancy/materials for the sidebar and popovers
instead of painting opaque panels. Reserve any visible glow exclusively for the
focus `ring`.

- **flat** — borders only, no shadow (rows, inline controls).
- **raised** — `0 1px 2px oklch(0 0 0 / 0.30)` (cards, active tab).
- **floating** — `0 8px 24px oklch(0 0 0 / 0.40)` (popovers, menus, dialogs).

## Shapes

Rounded rectangles throughout, on a tight radius scale: `6px` for small controls
(buttons, inputs, tabs), `8px` default, `10px` for cards and panels, `14px` for
large containers, and full-round only for pills and avatars. Avoid sharp 0px
corners (reads web-brutalist, not native) and avoid large pill-shaped buttons.
Borders are always `1px` hairlines.

## Components

- **Buttons.** Primary is a solid Codex-blue fill with soft-white text, `30px`
  tall, `6px` radius. On hover the fill deepens slightly (`primary-hover`, L 0.52)
  rather than lightening, preserving white-text contrast and reading as a
  native press. Secondary is an `elevated` fill with a hairline; ghost is
  transparent until hover, where it picks up the `muted` fill. Reserve the blue
  primary for the single most important action in a view.
- **Inputs.** Sit on `background` (recessed, one step *below* surface) with an
  `input` hairline; focus swaps the border to `ring` and adds the focus glow.
- **Cards & popovers.** `elevated` fill, hairline border, `10px` radius, floating
  shadow for popovers only.
- **Sidebar / project rail.** `sidebar` fill (translucent where supported);
  active item is a `muted` block with `foreground` text and an `8px` radius.
- **Tabs (per-branch).** Inactive tabs are `subtle` text on `surface`; the active
  tab is raised to `elevated` with `foreground` text — a flush, native tab strip.
- **Diff view.** Added lines use `success` as a low-alpha background wash with
  `on-success` gutter marks; removed lines use `destructive` the same way. Keep
  the wash subtle so monospace text stays the focus.
- **State badges.** `skill` pills annotate agent/skill activity; `warning` pills
  flag agent attention (permission / question / error). Both are full-round
  caption-sized chips.

## Do's and Don'ts

- **Do** keep the accent count at one. Blue is interaction; the semantic colors
  are state. Nothing else is colored.
- **Do** carry structure with hairline borders and elevation steps, not shadows.
- **Do** use the monospace face for anything code-shaped — paths, SHAs, branches,
  terminal and agent output — and the system face for everything else.
- **Do** lean on native materials (vibrancy, translucency) for the rail and
  popovers on macOS.
- **Don't** use pure black (`#000`) or pure white (`#fff`); the ramp is soft
  charcoal and soft white.
- **Don't** reach for gradients, glows, or large drop shadows — they break the
  native feel. The only glow is the focus ring.
- **Don't** widen the type scale to create hierarchy; use weight and tracking.
- **Don't** introduce a display serif or a third typeface.
- **Don't** let saturated color decorate; if a color isn't communicating state
  or interaction, it shouldn't be there.

## shadcn Integration

> This trailing section is outside the canonical spec order and exists so the
> file stays self-contained. The normative tokens live in the front matter; the
> CSS below is the derived shadcn (Tailwind v4) preset. The companion
> `globals.css` ships the full `:root` (light) + `.dark` blocks and `@theme`
> mapping; keep it as the runtime source of truth and re-derive it from these
> tokens, not by hand.

Mapping from DESIGN.md tokens to shadcn CSS variables (dark / canonical):

| shadcn variable          | DESIGN.md token        |
| ------------------------ | ---------------------- |
| `--background`           | `colors.surface`       |
| `--foreground`           | `colors.foreground`    |
| `--card` / `--popover`   | `colors.elevated`      |
| `--primary`              | `colors.primary`       |
| `--primary-foreground`   | `colors.on-primary`    |
| `--secondary` / `--muted`| `colors.muted`         |
| `--muted-foreground`     | `colors.subtle`        |
| `--accent`               | `colors.muted`         |
| `--destructive`          | `colors.destructive`   |
| `--border`               | `colors.border`        |
| `--input`                | `colors.input`         |
| `--ring`                 | `colors.ring`          |
| `--sidebar`              | `colors.sidebar`       |
| `--radius`               | `rounded.lg` (0.625rem)|

Plus three Pragma-specific extension variables that shadcn doesn't define but
the diff/agent UI needs: `--diff-added` (`colors.success`), `--diff-removed`
(`colors.destructive`), and `--skill` (`colors.skill`).