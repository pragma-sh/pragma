# `apps/www` — Pragma marketing + docs site

Public website for Pragma: a Next.js (App Router) app serving marketing pages at `/`,
plugin gallery at `/plugins`, and documentation at `/docs`. It is **not** part of desktop
app. Its only `@pragma/*` dependency is data-only `@pragma/plugin-registry`; nothing in
desktop app may import from website.

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
├── content/docs/            # MDX documentation pages (the /docs sidebar mirrors this tree)
├── proxy.ts                 # serves raw markdown for `.md` URLs and markdown-preferring clients
└── src/
    ├── app/
    │   ├── (home)/          # marketing route group (landing page + plugin gallery)
    │   ├── docs/            # DocsLayout + the [[...slug]] page
    │   ├── api/search/      # Fumadocs search endpoint (Orama, built from the source)
    │   ├── api/updates/     # Desktop auto-update check (`GET /api/updates`; no `@pragma/*`)
    │   ├── llms.txt/, llms-full.txt/, llms.mdx/  # machine-readable docs output
    │   ├── og/docs/         # per-page OG images
    │   └── global.css       # Tailwind + shadcn tokens + Fumadocs preset
    ├── components/
    │   ├── ui/              # shadcn primitives — do not hand-edit, re-add via the CLI
    │   ├── mdx.tsx          # MDX component map exposed to docs authors
    │   └── hero-scene.tsx   # react-three-fiber canvas (client component)
    └── lib/
        ├── shared.ts        # app name, routes, GitHub repo, site URL — single source of truth
        ├── plugins.ts       # official-lock fetch, validation, install deep links
        ├── updates.ts       # Desktop check API: evaluate `release.json`, GitHub fetch, dev fixture
        ├── source.ts        # Fumadocs content source + LLM/OG/markdown URL helpers
        └── layout.shared.tsx # nav options shared by the home and docs layouts
```

## Rules

- **Theming goes through one file.** `src/app/global.css` holds the shadcn tokens;
  `fumadocs-ui/css/shadcn.css` maps them onto the `--color-fd-*` tokens Fumadocs uses, so
  a color is defined once and both systems follow. Never restate a token in a component.
- **Route strings live in `lib/shared.ts`.** `/docs`, `/og/docs`, and `/llms.mdx/docs` are
  referenced by the source loader, the proxy, and the page components — change them there.
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
- **Docs content is a placeholder.** Pragma is still being implemented; `content/docs`
  holds one index page so the route, the search index, and the llms.txt output have
  something to serve. Add real pages as features land.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
