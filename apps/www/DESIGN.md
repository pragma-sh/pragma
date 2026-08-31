---
version: alpha
name: Pragma
description: "A confident dark-canvas builder marketing site that treats the page like a working artboard — near-black surfaces, white display type set with aggressive negative tracking, and a single confident blue (#0099ff) reserved for hyperlinks, focus, and selection. The page rhythm is broken by oversized vibrant gradient atmosphere panels — magenta, violet, orange spotlights — that act as living showcase tiles, not decoration. Every CTA is a white pill on dark; every card is a charcoal surface; every section title pulls letter-spacing tight enough to feel like a poster."

colors:
  primary: "#ffffff"
  on-primary: "#000000"
  accent-blue: "#0099ff"
  ink: "#ffffff"
  ink-muted: "#999999"
  canvas: "#090909"
  surface-1: "#141414"
  surface-2: "#1c1c1c"
  hairline: "#262626"
  hairline-soft: "#1a1a1a"
  inverse-canvas: "#ffffff"
  inverse-ink: "#000000"
  gradient-magenta: "#d44df0"
  gradient-violet: "#6a4cf5"
  gradient-blue: "#2f6bff"
  gradient-orange: "#ff7a3d"
  gradient-coral: "#ff5577"
  semantic-success: "#22c55e"

typography:
  display-xxl:
    fontFamily: Geist
    fontSize: 96px
    fontWeight: 500
    lineHeight: 0.85
    letterSpacing: -4.8px
  display-xl:
    fontFamily: Geist
    fontSize: 85px
    fontWeight: 500
    lineHeight: 0.95
    letterSpacing: -4.25px
  display-lg:
    fontFamily: Geist
    fontSize: 62px
    fontWeight: 500
    lineHeight: 1.00
    letterSpacing: -3.1px
  display-md:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.13
    letterSpacing: -1.0px
  headline:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.20
    letterSpacing: -0.8px
    fontFeature: cv05
  subhead:
    fontFamily: Inter Variable
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.30
    letterSpacing: -0.01px
    fontFeature: cv11
  body-lg:
    fontFamily: Inter Variable
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.30
    letterSpacing: -0.18px
    fontFeature: cv11
  body:
    fontFamily: Inter Variable
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.30
    letterSpacing: -0.15px
    fontFeature: cv11
  body-sm:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.40
    letterSpacing: -0.14px
    fontFeature: cv11
  caption:
    fontFamily: Inter Variable
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.20
    letterSpacing: -0.13px
    fontFeature: cv11
  micro:
    fontFamily: Inter Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.20
    letterSpacing: -0.12px
    fontFeature: cv11
  button:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: -0.14px
    fontFeature: cv11
  mono:
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.50
    letterSpacing: -0.13px

rounded:
  xs: 4px
  sm: 6px
  md: 10px
  lg: 15px
  xl: 20px
  xxl: 30px
  pill: 100px
  full: 9999px

spacing:
  hair: 1px
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 15px
  lg: 20px
  xl: 30px
  xxl: 40px
  section: 96px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 10px 15px
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 10px 15px
  button-translucent:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 8px 14px
  button-icon-circular:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
    size: 40px
  text-input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 10px 14px
  text-input-focused:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 10px 14px
  feature-card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: 24px
  feature-card-featured:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: 24px
  media-tile:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xl}"
    padding: 16px
  terminal-card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.xl}"
    padding: 16px
  gradient-spotlight-card:
    backgroundColor: "{colors.gradient-blue}"
    textColor: "{colors.ink}"
    typography: "{typography.subhead}"
    rounded: "{rounded.xxl}"
    padding: 32px
  comparison-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
  top-nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    height: 56px
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: 64px 32px
---

## Overview

Pragma's marketing canvas is a near-pure black artboard. The dominant surface is
`{colors.canvas}` — almost pure black — and on top of it sits oversized white display type
with letter-spacing pulled to extreme negative values (-5% of the size at every display
tier). The page reads like a poster: one assertive statement per band, generous breathing
room above and below.

The single accent is `{colors.accent-blue}` — used scarcely, for hyperlinks, focus rings,
selection states, and the shell prompt in the terminal card. The brand chrome itself is
monochrome: white pill buttons, charcoal cards, gray secondary text. The rhythm break is
the **gradient atmosphere card**: one magenta → violet → blue spotlight dropped into an
otherwise monochrome page — a small living poster inside the dark canvas.

Body type is **Inter Variable**, leaning into Inter's character variants (`cv01`, `cv05`,
`cv09`, `cv11`, `ss03`, `ss07`, `dlig`) — the result is a body voice that feels
custom-tuned, with a single-storey "a" and a straight-leg "l". **There is no light mode on
the marketing page; the brand IS dark.** `/docs` is a different surface and keeps the
Fumadocs light/dark toggle.

**Key Characteristics:**

- Black-canvas marketing system: `{colors.canvas}` is the surface for hero, feature run,
  comparison, closing CTA, and footer alike — no light interludes.
- Massive negative letter-spacing on display sizes (-5% at display-xxl/xl/lg, -3% at
  display-md) creates a poster-grade headline cadence.
- White pill (`{components.button-primary}`) is the only primary CTA shape on the page;
  secondary actions live as charcoal pills (`{components.button-secondary}`) or text links.
- One oversized **gradient spotlight card** — a magenta → violet → blue wash — is the
  page's only decorative surface; it is a card, not a section background.
- Inter Variable with bespoke OpenType character variants everywhere body type appears.
- Border radius runs from 4px utility chips up to 100px pills and full circles, with
  15–20px the default for cards and 30px for atmospheric gradient panels.
- A single chromatic accent `{colors.accent-blue}` reserved for hyperlinks, focus, and
  selection — never decorative, never a fill.

## Colors

### Brand & Accent

- **Pure White** ({colors.primary}): The brand primary surface. Every primary CTA pill,
  every display headline, every emphasized body line on canvas.
- **Sky Blue** ({colors.accent-blue}): The single chromatic accent. Hyperlinks, focus
  rings, selection states, and the `$` shell prompt — not the fanout branch graph, which is
  monotone. Never a background, never a brand fill.

### Surface

- **Canvas** ({colors.canvas}): Default page background — near-black. Hero, feature run,
  comparison, CTA, and footer all sit on it.
- **Surface 1** ({colors.surface-1}): One step above canvas — cards, secondary buttons,
  media tiles, and the bento band.
- **Surface 2** ({colors.surface-2}): Two steps above — the featured card, popovers, and
  translucent buttons over busy ground.
- **Hairline** ({colors.hairline}): 1px borders — card edges, section top rules, table
  dividers.
- **Hairline Soft** ({colors.hairline-soft}): Subtler dividers — footer column rules.
- **Inverse Canvas** ({colors.inverse-canvas}): Pure white — the surface of the primary
  pill CTA, and light screenshots embedded in a tile.

### Text

- **Ink** ({colors.ink}): All headline and emphasized body type — pure white.
- **Ink Muted** ({colors.ink-muted}): Secondary type — gray (#999999) for descriptions,
  footer columns, comparison labels, and meta. Hierarchy on the dark canvas is carried by
  ink → ink-muted contrast, not by weight changes.

### Semantic

- **Success Green** ({colors.semantic-success}): Terminal success lines and comparison
  checkmarks. Glyph fill, not surface.

### Brand Gradient (signature)

- **Gradient Magenta** ({colors.gradient-magenta}) → **Gradient Violet**
  ({colors.gradient-violet}) → **Gradient Blue** ({colors.gradient-blue}) is the spotlight
  run, in that order: the panel opens warm and lands cool, which keeps it from reading as a
  flat purple. **Gradient Orange** ({colors.gradient-orange}) and **Gradient Coral**
  ({colors.gradient-coral}) are the warm alternates, unused on the page today.

`{colors.gradient-blue}` is a _gradient anchor_, not `{colors.accent-blue}` — the accent
stays a signal colour for links, focus, and selection, and never becomes a fill. A dark
canvas with a single glowing spotlight card is the page signature.

## Typography

### Font Family

- **Geist** — the display typeface. Geometric, confident at large sizes with extreme
  negative tracking, and already the app's face. Weight 500–600 at display sizes.
- **Inter Variable** — the body typeface, used with OpenType character variants `cv01`
  (alternate "1"), `cv05` (alternate "g"), `cv09` (alternate "i"/"l"), `cv11` (alternate
  "0"), `ss03`/`ss07` stylistic sets, and `dlig`. The result is a body voice that feels
  bespoke without commissioning a custom face.
- **Geist Mono** — terminal cards, inline code, and command samples.

### Hierarchy

| Token                      | Size | Weight | Line Height | Letter Spacing | Use                                 |
| -------------------------- | ---- | ------ | ----------- | -------------- | ----------------------------------- |
| `{typography.display-xxl}` | 96px | 500    | 0.85        | -4.8px         | Hero headline, closing CTA          |
| `{typography.display-xl}`  | 85px | 500    | 0.95        | -4.25px        | Section opener headlines            |
| `{typography.display-lg}`  | 62px | 500    | 1.00        | -3.1px         | Sub-section openers                 |
| `{typography.display-md}`  | 32px | 500    | 1.13        | -1.0px         | Card titles, smaller display        |
| `{typography.headline}`    | 22px | 700    | 1.20        | -0.8px         | Card headlines                      |
| `{typography.subhead}`     | 24px | 400    | 1.30        | -0.01px        | Lead body next to display headlines |
| `{typography.body-lg}`     | 18px | 400    | 1.30        | -0.18px        | Hero subhead, section descriptions  |
| `{typography.body}`        | 15px | 400    | 1.30        | -0.15px        | Default body, card descriptions     |
| `{typography.body-sm}`     | 14px | 500    | 1.40        | -0.14px        | Feature points, dense data          |
| `{typography.caption}`     | 13px | 500    | 1.20        | -0.13px        | Footer columns, meta                |
| `{typography.micro}`       | 12px | 400    | 1.20        | -0.12px        | Disclaimer, footnote                |
| `{typography.button}`      | 14px | 500    | 1.0         | -0.14px        | Pill buttons                        |
| `{typography.mono}`        | 13px | 400    | 1.50        | -0.13px        | Terminal card, code                 |

### Principles

- **Letter-spacing scales with size, hard.** Display tiers pull -5% of their size; body
  sticks to about -1%. Posters at the top, comfortable reading at body. Implement in `em`
  so the percentage survives every breakpoint.
- **OpenType character variants are the brand voice.** Switching off `cv11`, `ss03`, etc.
  visibly changes the body voice — the brand depends on them.
- **Weight stays in a narrow band.** Display at 500–600, body at 400, body-sm/caption at 500. Hierarchy is carried by size + tracking, not by a 700/900 ramp.
- **Tight line-heights everywhere.** Even body runs at 1.30 — the editorial tone is denser
  than typical SaaS marketing.

## Layout

### Spacing System

- **Base unit**: 5px (5/10/15/20/30 increments rather than the more common 4/8/16/24).
- **Tokens (front matter)**: `{spacing.hair}` 1px · `{spacing.xxs}` 4px · `{spacing.xs}`
  8px · `{spacing.sm}` 12px · `{spacing.md}` 15px · `{spacing.lg}` 20px · `{spacing.xl}`
  30px · `{spacing.xxl}` 40px · `{spacing.section}` 96px.
- Card interior padding: `{spacing.lg}` 20px on feature cards; `{spacing.xl}` 30px on
  gradient spotlight cards.
- Pill button padding: 10px vertical · 15px horizontal — `{components.button-primary}`.
- Section padding (vertical): roughly `{spacing.section}` 96px.

### Grid & Container

- Max content width is 1152px (`max-w-6xl`) with side gutters that scale toward
  `{spacing.xl}` on desktop; the hero screenshot is allowed a wider 1225px well.
- The feature run is one 12-column grid: copy in 5 columns, media in 7, and `flip` is the
  only variation between sections.
- The bento grid is hand-packed to 12 columns per row and collapses to 1-up below 640px.

### Whitespace Philosophy

The dark canvas IS the whitespace. Where lighter brands lean on white air to separate
sections, Pragma leans on long stretches of black with a single oversized statement
floating in the middle. Sections separate by mode change: a run of canvas bands, then a
band of charcoal cards, then back to canvas — like cuts in a dark film.

## Elevation & Depth

| Level          | Treatment                                                                     | Use                                                 |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| 0 (flat)       | No shadow, no border                                                          | Canvas-mounted display type, feature points, footer |
| 1 (charcoal)   | `{colors.surface-1}` lift on canvas                                           | Cards, media tiles, secondary buttons               |
| 2 (light-edge) | `rgba(255,255,255,0.10)` 0.5px top edge + `rgba(0,0,0,0.25)` 0 10px 30px drop | Floating hero screenshot, terminal card             |
| 3 (selected)   | `rgba(0,153,255,0.15)` 0 0 0 1px ring                                         | Focused inputs, selected option                     |

### Decorative Depth

- **Gradient spotlight cards** are the dominant depth device — color saturation against
  black canvas substitutes for shadow-driven elevation.
- **The hero screenshot** sits in a `{colors.surface-1}` frame with the level-2 treatment
  and reflects into the section below it.
- **The blue ring** is the only chromatic depth signal, and only for focus/selection.

## Shapes

### Border Radius Scale

| Token            | Value  | Use                                        |
| ---------------- | ------ | ------------------------------------------ |
| `{rounded.xs}`   | 4px    | Small chip / utility radius                |
| `{rounded.sm}`   | 6px    | Inline tag, badge                          |
| `{rounded.md}`   | 10px   | Form input, list item                      |
| `{rounded.lg}`   | 15px   | Small tiles, inline media                  |
| `{rounded.xl}`   | 20px   | Cards, media tiles, terminal card          |
| `{rounded.xxl}`  | 30px   | Gradient spotlight cards, oversized panels |
| `{rounded.pill}` | 100px  | All text CTAs                              |
| `{rounded.full}` | 9999px | Circular icon buttons, status dots         |

### Media Geometry

- Screen recordings and screenshots sit in `{rounded.xl}` 20px tiles and never crop.
- Gradient spotlight cards use `{rounded.xxl}` 30px corners — softer than content cards by
  design, so they read as atmospheric panels rather than tighter UI.
- Icon glyphs render in `{rounded.full}` circles at 32–40px.

## Components

### Buttons

**`button-primary`** — White pill on dark canvas. The primary CTA in the hero and the
closing call to action.

- Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.button}`,
  padding 10px 15px, rounded `{rounded.pill}`.

**`button-secondary`** — Charcoal pill for secondary actions ("Read the docs", "GitHub").

- Background `{colors.surface-1}`, text `{colors.ink}`, rounded `{rounded.pill}`.

**`button-translucent`** — Lifted secondary used on top of busy ground (a gradient card).

- Background `{colors.surface-2}`, text `{colors.ink}`, rounded `{rounded.pill}`.

**`button-icon-circular`** — 40px circle for inline icon actions.

### Cards & Containers

**`feature-card`** — Bento tile. Background `{colors.surface-1}`, rounded `{rounded.xl}`,
padding 24px.

**`feature-card-featured`** — Available for a genuinely primary tile, lifted to
`{colors.surface-2}`; the lift is one surface step, never a chromatic outline. The bento
grid deliberately uses none — its twelve items are peers.

**`media-tile`** — Reserved space for a screen recording, drawn as a player frame.
Background `{colors.surface-1}`, rounded `{rounded.xl}`.

**`terminal-card`** — Sample CLI session. Background `{colors.surface-1}`, type
`{typography.mono}`, rounded `{rounded.xl}`; the `$` prompt is `{colors.accent-blue}` and
success output is `{colors.semantic-success}`.

### Gradient Spotlight Cards (signature)

Oversized atmospheric tiles dropped into otherwise monochrome grids.

**`gradient-spotlight-card`** — a 118° wash running `{colors.gradient-magenta}` →
`{colors.gradient-violet}` → `{colors.gradient-blue}`, with a soft white highlight at the
top-left corner and the final stop darkened toward black so white type holds contrast at
the far edge. Text `{colors.ink}`, type `{typography.subhead}`, rounded `{rounded.xxl}`,
padding 32px.

**The page ships exactly one full-strength spotlight, and it is the closing call to action.**
Its gradient shifts slowly across the card and stops under reduced motion. The fanout section
carries a low-opacity **branch graph** behind its copy instead — a sideways tree of one base
commit splitting into attempts, drawn monotone in `currentColor` with a slow pulse travelling
out along each rail; it is geometry, not a second gradient spotlight.

### Comparison

**`comparison-row`** — a row of the feature matrix. `{colors.canvas}` ground,
`{colors.ink-muted}` text, `{typography.body-sm}`, 1px `{colors.hairline-soft}` underline.
The Pragma column is marked by a faint white wash and `{colors.accent-blue}` checkmarks —
never a coloured fill.

### Navigation

**`top-nav`** — Sticky bar on `{colors.canvas}` with the Pragma mark and wordmark left and
the docs/GitHub links right. Height 56px, type `{typography.body-sm}`.

### Footer

**`footer`** — Link grid on `{colors.canvas}` with the wordmark and a closing line left,
and columns of caption-sized links right. Text `{colors.ink-muted}`, padding 64px 32px.

## Do's and Don'ts

### Do

- Reserve `{colors.primary}` (white) and `{colors.canvas}` (near-black) as the system's two
  anchor surfaces.
- Push display-size letter-spacing aggressively negative — -5% is the brand signature, not
  a stylistic accident.
- Use `{colors.accent-blue}` only for hyperlinks, focus rings, selection, and the terminal
  prompt.
- Keep the `gradient-spotlight-card` to one per page; it is the brand's atmosphere device
  and it works by being scarce. Its slow background shift is the page's closing motion.
- Keep the fanout branch graph quiet enough to sit behind copy, monotone, and stop its
  pulses when `prefers-reduced-motion` is enabled.
- Compose every CTA as a pill (`{rounded.pill}`); secondary actions are charcoal pills,
  never bordered ghost buttons.
- Keep body type Inter Variable with its character variants enabled — the brand voice
  depends on them.
- Use surface lift (canvas → surface-1 → surface-2) to mark hierarchy, not opacity changes
  on white type.

### Don't

- Don't ship a light-mode marketing page. The landing identity is dark. (`/docs` is a
  separate surface and keeps its toggle.)
- Don't introduce mid-tone gray text outside `{colors.ink-muted}`. The hierarchy is binary:
  `ink` or `ink-muted`.
- Don't use `{colors.accent-blue}` as a brand fill (e.g. a blue CTA pill). It is a signal
  color, not a surface.
- Don't square off CTAs. Pill or full circle is the vocabulary.
- Don't reduce the negative letter-spacing on display sizes "for accessibility". Reduce the
  SIZE if needed, but keep the percentage.
- Don't apply gradient backgrounds to whole sections. The subdued fanout branch graph is
  the sole section-background exception, and it is monotone; gradients remain CARDS, not
  grounds.
- Don't combine more than one chromatic accent. The palette is monochrome plus one blue
  plus the gradient family.

## Responsive Behavior

### Breakpoints

| Name    | Width      | Key Changes                                                     |
| ------- | ---------- | --------------------------------------------------------------- |
| Desktop | 1024px+    | Feature run splits into copy + media columns; bento is 12-up    |
| Tablet  | 640–1023px | Feature run stacks; bento collapses to 2-up                     |
| Mobile  | < 640px    | Single-column everything; comparison table scrolls horizontally |

### Touch Targets

- Pill buttons keep a minimum 44px tap height across all viewports.
- Circular icon buttons are 40px on desktop and grow to 44px on touch viewports.

### Collapsing Strategy

- **Feature run**: the 5/7 split stacks to one column; the media follows its copy.
- **Card grids**: bento goes 12-up → 2-up → 1-up. The gradient spotlight card keeps
  `{rounded.xxl}` corners at every viewport — it doesn't bleed.
- **Display type**: `{typography.display-xxl}` scales down toward `{typography.display-lg}`
  on tablet and `{typography.display-md}` on mobile, preserving the percentage tracking.
  Implement with `clamp()`, not a breakpoint ladder.

## Implementation

The tokens above are implemented once, in `src/app/global.css`:

- The absolute brand constants live as `--ds-*` custom properties on `:root`.
- `.artboard` (applied with `dark` on the `(home)` route group) remaps the shadcn/ui
  variables onto them, so every primitive follows without restating a colour.
- Display tiers ship as `.type-display-*` component classes using `clamp()` + `em`
  tracking; the gradient panel ships as the single `.spotlight` class, and CTAs as
  `.pill-cta`.
- Fonts load in `src/app/layout.tsx`: Geist (`--font-geist-sans`), Inter
  (`--font-inter`, bound to the `font-body` utility), Geist Mono (`--font-geist-mono`).

**Any change to the theme is a change to this file first.** Edit the tokens and the prose
here in the same commit that edits `global.css` or a landing component — this document is
the source of truth, not a snapshot.

## Known Gaps

- Gradient spotlight cards are authored as `linear-gradient` strings anchored on the
  documented `{colors.gradient-*}` hexes; treat those hexes as anchors, not exact stops.
- Form-field validation / error styling is not specified — the landing page has no forms
  yet.
- The `/docs` surface still runs the Fumadocs light/dark ramp; only the marketing route
  group is pinned to the artboard palette.
- `{colors.gradient-orange}` and `{colors.gradient-coral}` are specified but unused — they
  exist as the warm alternates for a future panel, and no CSS ships for them.
