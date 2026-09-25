# www

Marketing site and documentation for Pragma.

```bash
bun run dev:www   # from the repo root, then open http://localhost:3000
```

Marketing pages live in `src/app/(home)`; documentation is written as MDX in
`content/docs` and served at `/docs`.

## Publish a blog post

Add a `.md` or `.mdx` file directly under `content/blog/`. Its filename becomes the
`/blog/<filename>` URL. For example, `content/blog/my-new-post.md`:

```md
---
title: My new post
description: A short summary for the blog index and link previews.
date: "2026-09-24"
cover:
  src: /blog/my-cover.png
  alt: Description of the cover image
video:
  src: https://example.com/launch-film.mp4
  poster: /blog/my-cover.png
  captions: /blog/my-captions.vtt
---

Write the post in Markdown here. MDX works too.
```

`title`, `description`, and a quoted ISO `date` are required. `cover` and `video`
are optional. Put local cover and poster files in `public/blog/` and include both
`src` and descriptive `alt` for a cover. A `video` needs a public HTTPS URL and
appears as the featured media and an article player; it requires a WebVTT `captions`
file alongside it. `cover` remains its share image.
Fumadocs compiles the post, the newest date is featured at
`/blog`, and older posts appear below it. Run `bun run --filter www build` to verify
the new route.

See `AGENTS.md` for the full layout and conventions.
