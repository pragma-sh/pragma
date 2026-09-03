# `apps/www` — Pragma marketing + docs site

Public website for Pragma: a Next.js (App Router) app serving marketing pages at `/`,
plugin gallery at `/plugins`, and documentation at `/docs`. It is **not** part of desktop
app. Its `@pragma/*` dependencies are data-only `@pragma/plugin-registry` and render-only
`@pragma/brand`; nothing in desktop app may import from website.

## Stack

| Concern    | Choice                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| Framework  | [Next.js 16](https://nextjs.org) App Router (Turbopack), React 19        |
| Docs       | [Fumadocs](https://fumadocs.dev) (`fumadocs-core` + `fumadocs-ui` + MDX) |
| Styling    | Tailwind CSS v4 via `@tailwindcss/postcss`                               |
| Components | [shadcn/ui](https://ui.shadcn.com) (`new-york`, neutral, RSC)            |
| 3D         | three.js + [react-three-fiber](https://r3f.docs.pmnd.rs) + drei          |

## Commands

```bash
bun run dev:www                       # from the repo root
bun run --filter www build            # production build
bun run --filter www typecheck        # fumadocs-mdx + next typegen + tsc
bunx --bun shadcn@latest add <name>   # from apps/www — writes to src/components/ui
```

`fumadocs-mdx` generates the gitignored `.source/` directory that `lib/source.ts` reads.
Every script that touches types or builds runs it first, so there is no separate step —
but a bare `next dev`/`tsc` in a clean checkout will fail until you run `fumadocs-mdx`.

## Layout

```
apps/www/
├── DESIGN.md                # the marketing design system — tokens + rules, edited before the CSS
├── content/docs/            # MDX documentation pages (the /docs sidebar mirrors this tree)
├── proxy.ts                 # serves raw markdown for `.md` URLs and markdown-preferring clients
├── public/
│   ├── agents/              # official agent marks, copied from `packages/*-plugin/assets`
│   ├── media/               # product screenshots and self-hosted screen recordings
│   └── pragma-app.png       # hero screenshot of the desktop app
└── src/
    ├── app/
    │   ├── (home)/          # marketing route group (landing, plugins, privacy, deep-link
    │   │                    # forwarders /open + /install-plugin, plugins/[...package]) in
    │   │                    # the `.artboard` layout
    │   ├── docs/            # DocsLayout + the [[...slug]] page
    │   ├── api/search/      # Fumadocs search endpoint (Orama, built from the source)
    │   ├── api/updates/     # Desktop auto-update check (`GET /api/updates`; no `@pragma/*`)
    │   ├── llms.txt/, llms-full.txt/, llms.mdx/  # machine-readable docs output
    │   ├── og/docs/         # per-page OG images
    │   └── global.css       # Tailwind + shadcn tokens + the `.artboard` palette + Fumadocs preset
    ├── components/
    │   ├── ui/              # shadcn primitives — do not hand-edit, re-add via the CLI
    │   ├── mdx.tsx          # MDX component map exposed to docs authors
    │   ├── site-navbar.tsx  # shared floating marketing/docs nav + docs mobile sidebar trigger
    │   ├── brand-favicon.tsx # compact mark rendered from @pragma/brand geometry
    │   ├── github-mark.tsx  # shared GitHub brand glyph
    │   ├── plugin-card.tsx  # gallery preview cell — stretched link to the detail page
    │   ├── deep-link-forward.tsx  # one pragma:// hand-off page (auto-redirect + fallback pills)
    │   └── home/            # landing page sections
    │       ├── agents.ts            # the shipped agent integrations (id, name, mark, tint)
    │       ├── agent-chip-field.tsx # react-three-fiber canvas of floating agent chips
    │       ├── chip-physics.ts      # pure 2D simulation behind that canvas
    │       ├── fanout-scene.tsx     # react-three-fiber canvas of racing fan-out lanes
    │       ├── section.tsx          # Reveal, SectionShell, SectionHeading, FeatureSection variants
    │       ├── terminal-card.tsx, device-frame.tsx
    │       ├── hero.tsx, bento.tsx,
    │       └── comparison.tsx, cta.tsx, site-footer.tsx
    └── lib/
        ├── css-color.ts     # resolves a CSS token to hex so three.js can use the palette
        ├── legal.ts         # privacy route + last-updated date — the URL App Store Connect is given
        ├── shared.ts        # app name, routes, GitHub repo, site URL — single source of truth
        ├── deep-link.ts     # pragma:// deep-link forwarder URL builders (web ⇄ scheme)
        ├── plugins.ts       # official-lock fetch, validation, detail/install/source links
        ├── updates.ts       # Desktop check API: evaluate `release.json`, GitHub fetch, dev fixture
        ├── source.ts        # Fumadocs content source + LLM/OG/markdown URL helpers
        └── layout.shared.tsx # nav options shared by the home and docs layouts
```

## Rules

- **`DESIGN.md` is the source of truth for the theme, and it is edited first.** The
  marketing design system — palette, type scale, radii, spacing, component specs — is
  specified in `apps/www/DESIGN.md`. Any change to the look of the landing page changes
  that file **in the same commit** as the CSS or the component. Don't treat it as a
  snapshot of what shipped; treat the code as an implementation of it.
- **Theming goes through one file.** `src/app/global.css` implements `DESIGN.md`: the
  brand constants as `--ds-*` on `:root`, the `.artboard` block remapping the shadcn
  variables onto them, the `type-display-*` / `spotlight*` / `pill-cta` component classes.
  `fumadocs-ui/css/shadcn.css` maps the shadcn variables onto the `--color-fd-*` tokens
  Fumadocs uses, so a colour is defined once and both systems follow. Never restate a
  token in a component — a literal hex or a hand-mixed grey in a `className` is a bug.
- **Route strings live in `lib/shared.ts`.** `/docs`, `/og/docs`, and `/llms.mdx/docs` are
  referenced by the source loader, the proxy, and the page components — change them there.
- **`/{action}` pages forward deep links; they do not parse them.** GitHub's markdown
  sanitizer keeps only `http`/`https` hrefs, so every link that must survive a PR body
  points at a web route (`/open?...`, `/install-plugin?...`) whose `DeepLinkForward`
  component relays the query verbatim to `pragma://{action}` — once automatically on
  mount, and again through the primary pill anchor for browsers that suppress programmatic
  external-protocol launches. The action is a constant in the route file, never user
  input; add a new action by adding a route, not by widening a parser. The desktop's
  parser (`apps/pragma/src/lib/deep-link.ts`) owns what the params mean.
- **The plugin gallery consumes the official lock, and the detail page degrades with it.**
  `/plugins/[...package]` joins the segments back into the npm package identity and
  renders whatever the lock carries: `longDescription` falls back to `description`, the
  "View on npm" button is derived from the package identity alone (`pluginNpmUrl` — every
  official entry is an npm release), and screenshots render only when the manifest ships
  more than the header logo. Manifest changes only reach the remote lock when the packages
  are republished (`plugins.yml` publish → refresh-lock); never commit `lock:local`
  output — its tarball integrity hashes describe locally-packed bytes, not the npm
  releases the desktop verifies against.
- **`GET /api/updates` is the desktop check endpoint.** It must not import `@pragma/*`.
  The desktop sends `platform` plus running `ui`/`app`/`server`/`protocol` versions.
  Apply mode (`reload` vs `restart`) comes from `release.json`, never from the query.
  In development a local fixture stands in for that file; production fetches signed
  manifests from recent GitHub Releases. Do not use `/releases/latest`: another
  independently-versioned monorepo component may be newer. Walk reload manifests through
  the newest restart manifest so a client that skipped native releases gets the required
  installer before a newer UI overlay. An update without the requested
  UI/platform/package-format asset is unavailable rather than an un-installable offer.
- **Every three.js component is a client component.** `@react-three/fiber` cannot render on
  the server; keep `'use client'` at the top of the file that owns the `<Canvas>` and keep
  the rest of the page a server component.
- **`@react-three/fiber` pollutes `JSX.IntrinsicElements`.** It augments the global JSX
  namespace with every three.js export, which makes `mdx/types`' `MDXComponents` — indexed
  by intrinsic element name — reject the Fumadocs default component map. `components/mdx.tsx`
  casts around this; that cast is deliberate, don't "fix" it by widening the map's type.
- **Every feature section is the same section.** `FeatureSection` has one layout — copy
  and points in one column, media in the other — on one surface, with one `FeaturePoint`
  style. `flip` is the only prop that varies between them, and the page alternates it so
  the media walks right, left, right down the page. That is the whole vocabulary.
- **Do not add a treatment for one section.** This page has been through the other version
  of this: five layout variants, three backdrop patterns, three bullet styles, and an
  alternating tone, all cycled so that no two neighbours matched. It read as scatter, not
  as rhythm, and every axis has since been removed on purpose. A new section is another
  `FeatureSection` continuing the `flip` alternation — not a new variant, tone, pattern,
  or bullet style. If one genuinely needs to break the pattern, that is a design decision
  to raise, not a prop to add.
- **The uniform run stops at `Bento`.** `Bento`, `Comparison`, `CallToAction`, and
  `SiteFooter` are not feature sections and keep their own shapes — a card grid, a table,
  a centred closer, and the footer. `tone` still lives on `SectionShell` for them
  (`Bento` is `canvas`, `Comparison` is `invert`); the feature run above them does not
  use it.
- **Sections have no eyebrow.** `SectionHeading` used to take a small accent kicker
  above the headline ("Agent board", "Fan out", "Built-in AI"). It restated the headline
  in shorter words and put a second coloured element at the top of every section, so it
  went; the headline opens the section on its own. Don't add the prop back.
- **One per-section backdrop.** The fanout scene moved behind its section at low opacity when
  its media column became a video slot. It is the sole exception. Do not bring back the
  `dots`/`lines`/`hatch` patterns or add backdrop variants to other sections.
- **The hero screenshot reflects into the section below it.** The reflection is a second
  `<Image>` anchored to the top of a window 46% of the shot's height and flipped about
  its own centre, which lands the shot's bottom edge on the seam. Three things have to
  hold together for it to cross the boundary: the hero has **no** `overflow-hidden` (it
  was only ever there for the removed glow, which overflowed upward at `-top-40`), the
  hero carries `z-10` so it paints above the next section — a later positioned sibling
  would otherwise cover the bleed with its own background — and `#parallel` carries
  `className="border-t-transparent"` so the shell's hairline does not cut across it.
  If you grow the reflection further, check the mask has faded it out before
  `#parallel`'s heading: at 1440px there is ~96px of clearance.
- **No section numerals.** `SectionShell` used to paint an oversized `01`/`02` per
  section. The landing sections are a set of capabilities, not an ordered process, so the
  numbering asserted a sequence the content does not have. Don't reintroduce it. The
  same reasoning retired the `numbered` `PointList` style: its `01`/`02` counters implied
  an order that "many projects / nested worktrees / real terminals / trustworthy status"
  does not have.
- **`MediaSlot` reserves space for missing screen recordings — leave it reserved.** Real
  product media in `public/media/` replaces its matching slot through `MediaVideo` or
  `MediaImage`; do not fill remaining slots with illustrations, mock UI, or drawn schematics.
  An earlier pass replaced all seven with bespoke per-section artwork and both lost the plan
  and made the page busier. A slot is retired only by real product media. It is drawn as a
  player frame rather than a dashed box so the reserved space still looks deliberate, and it
  reserves the finished video's aspect so nothing reflows when one lands. The four wider
  bento tiles reserve screenshots the same way.
- **Every section stands on the canvas — there are no section tones.** `SectionShell` has
  no `tone` prop and `components/home/tones.ts` is gone. `DESIGN.md` is explicit that the
  dark canvas _is_ the whitespace: rooms are separated by what stands on the ground (a grid
  of charcoal cards, a gradient panel, a bordered table) and by the shells' top hairlines,
  never by tinting the ground. The earlier `plain`/`canvas`/`invert` map existed to fake a
  step in both light and dark; with one palette there is nothing to step between.
- **three.js scenes read their colours from the tokens.** `lib/css-color.ts` round-trips a
  custom property through a 1x1 canvas, because `THREE.Color` cannot parse oklch. Resolve
  against an element _inside_ the section (`useTokenColor(token, fallback, ref)`) so an
  inverted band hands the scene the palette it is actually painted in — never hard-code a
  hex that shadows a token.
- **The marketing page is the artboard, and it is dark-only.** `(home)/layout.tsx` wraps
  the route group in `dark artboard font-body`; `.artboard` supplies the `DESIGN.md`
  palette (`{colors.canvas}` #090909 → `{colors.surface-1}` → `{colors.surface-2}`, ink
  and ink-muted, one accent blue) and `html:has(.artboard)` paints the document canvas so
  overscroll and the first paint are not white. There is no light mode here and the nav's
  theme switch is disabled for that reason. `/docs` sits outside the wrapper and keeps the
  stock shadcn `neutral` ramp plus its toggle — the two are separate surfaces, and
  `apps/pragma/src/index.css` is a third. Do **not** re-sync them.
- **Hierarchy is carried by surface lift, not by opacity on white.** canvas → surface-1
  (`bg-card`) → surface-2 (`bg-elevated`), with `border-border` as the hairline. A
  `bg-card/50` or a `border-border/70` re-invents a surface the system already names;
  `DESIGN.md` lists exactly three, and text is binary — `text-foreground` or
  `text-muted-foreground`, nothing between.
- **One gradient spotlight card, and it is the closing call to action.** That magenta →
  violet → blue panel is the page's whole decorative allowance (`DESIGN.md` → Do's and
  Don'ts). It is a CARD: a gradient section ground is explicitly out. The bento grid used
  to carry a second one and lost it — twelve peer tiles with one singled out asserted a
  ranking the list does not have. Its gradient shifts slowly, with reduced motion respected.
  The subdued fanout geometry is not another spotlight.
- **Every CTA is a pill.** `.pill-cta` carries the geometry and the 44px tap target;
  primary is the white pill (`Button` default), secondary is the charcoal pill
  (`variant="secondary"`). No `variant="outline"`, no square button, no bordered ghost.
- **`--primary` is ink, `--brand` is the accent, and they are not interchangeable.**
  `--primary` is near-black in light mode and near-white in dark, so every button, badge,
  link, and focus ring is monochrome. `--brand` is the single chromatic token (blue) and
  is an accent only — the shell prompt in `TerminalCard`, the highlighted Pragma column in
  `Comparison`, the `FanoutScene` geometry. Never a button, a badge, a card fill, or a
  border. Two brand-coloured elements in one viewport means it is being overused; reach
  for `text-foreground`/`text-muted-foreground` instead.
- **`CodeCard` highlights with Shiki, in `github-dark`.** Fumadocs' `rehypeCode` already
  renders the docs with the GitHub theme pair, so the landing frame uses the dark half of
  it rather than a hand-rolled tokeniser or a second set of source colours. This is the
  one deliberate exception to the monochrome-plus-one-blue cap: source code reads as
  source code. Only the token colours are inlined — the card's surface, border, and
  chrome stay on the page's own tokens. `CodeCard` is an async server component, so
  highlighting happens at build time and the highlighter never ships to the browser.
- **Geist is the display face, Inter Variable is the body voice.** All three faces load
  through `next/font/google` in `app/layout.tsx` (`--font-geist-sans`, `--font-inter`,
  `--font-geist-mono`); `@theme inline` binds `--font-sans`/`--font-heading` to Geist,
  `--font-body` to Inter, and `--font-mono` to Geist Mono. Only the marketing wrapper wears
  `font-body`, and `.artboard` carries the OpenType character variants
  (`cv01/05/09/11`, `ss03/ss07`, `dlig`) that make Inter read as the brand rather than as
  the default. Display sizes use the `type-display-*` classes: `clamp()` for size, `em` for
  tracking, so the -5% compression survives every breakpoint.
- **Shadow strength is theme-dependent.** `--shadow-raised`/`--shadow-floating` resolve
  through per-theme `*-value` custom properties, because a drop that reads on a near-black
  surface is a smear on a white one.
- **Agent marks are copies, not imports.** `@pragma/brand` supplies only Pragma's own mark;
  official agent marks in `public/agents/` remain copies from each
  `packages/*-plugin/assets/` directory. Adding an agent plugin means copying its mark here
  and adding a row to `components/home/agents.ts`.
- **The hero canvas is opt-in per visitor.** `AgentChipField` renders nothing under
  `prefers-reduced-motion`; the page must read correctly without it. Width is not a
  gate — a narrow viewport re-seats the field instead of dropping it.
- **The chip field is laid out from measured geometry, never a breakpoint.**
  `planField` fits the chips to the rectangles the hero hands it: a column down each
  side gutter while one is wide enough, otherwise a single band arcing over the copy,
  walked outward from its middle by both halves of the field. Both are seated along
  `lanePath` — the _offset silhouette_ of everything the chips must avoid — so a lane
  leans toward the content wherever it is narrow: a column tucks in beside the heading
  before bulging back around the screenshot, and the band crowns the heading and curls
  down either side of it. Tune the seating in `chip-physics.ts`; do not add a media
  query, and do not special-case one layout.
- **Never seat a chip somewhere it cannot travel to.** The band used to put half the
  chips _below_ the screenshot: unreachable (the screenshot is the tallest obstacle on
  the page) and off the fold anyway, so those chips spent the whole session pressed
  against its underside with the home spring still pulling — which is what the field
  read as a permanent vibration. Everything above the copy is reachable from anywhere.
- **The solver's clearance is a rounded rectangle, matching the seating.** `lanePath`
  offsets the silhouette as a Minkowski sum, so its corners are round; `penetration`
  therefore measures a chip against the same rounded outline. Squaring the corners off
  (a plain padded box) makes every slot placed around a corner permanently illegal, and
  the resulting shove-versus-spring stand-off buzzes forever.
- **The hero reserves exactly the depth the band needs, and no more.** The band is as
  deep as the room above the heading, so extra top padding does not enlarge the chips —
  it only opens an empty strip under the nav.
- **`viewport` measures the plane at z = 0; the chips are drawn in front of it.** The
  prominent chips ride toward the camera and every chip bobs, and a perspective camera
  magnifies both their size _and_ their distance from centre. Seating the arc's crest
  against the raw half-height therefore projected it past the canvas edge and sliced the
  top off the band right under the nav. `ChipField` divides the bounds it hands both
  `planField` and `stepChips` by that magnification (`MAX_CHIP_DEPTH`), so the seating
  and the physics work in the box the chips actually land in. Changing a chip's z offset
  means changing `MAX_CHIP_DEPTH` with it.
- **The shared nav floats at the same viewport position on both surfaces.** Marketing uses
  `sticky` so its 68px row (12px top offset plus 56px bar) remains in flow above the hero;
  docs uses `fixed` because a full-width grid child changes Fumadocs' mobile track sizing.
  Docs adds matching top padding and reserves that offset for its sticky sidebar.
- **`/privacy` is an App Store submission artifact, not a marketing page.** App Store
  Connect stores its URL for Pragma Go and App Review follows it, which is why it is
  reached by URL and deliberately kept out of the site navigation. Change its route only
  by changing `lib/legal.ts` **and** the URL in App Store Connect — a dead policy URL is
  grounds for rejection on the next update. The page must keep describing what the apps
  actually do with data (see `apps/pragma-go/AGENTS.md`); it is written to cover future
  analytics and hosted services as _disclosed-before-they-launch_, so adding either means
  editing the page and bumping `privacyLastUpdated` **before** the code ships, not after.
  Support is handled through GitHub issues, so there is no support page here.
- **Docs content is a placeholder.** Pragma is still being implemented; `content/docs`
  holds one index page so the route, the search index, and the llms.txt output have
  something to serve. Add real pages as features land.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
