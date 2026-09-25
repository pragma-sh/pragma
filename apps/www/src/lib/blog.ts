import { loader } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

import { publishedFirst } from "./blog-utils";
import { blogRoute } from "./shared";

const blog = defineDocs({
  dir: "content/blog",
  docs: {
    schema: pageSchema.extend({
      description: z.string().min(1),
      date: z.iso.date(),
      cover: z
        .object({
          src: z.string().min(1),
          alt: z.string().min(1),
        })
        .optional(),
      video: z
        .object({
          src: z.url(),
          poster: z.string().min(1),
          captions: z.string().min(1),
        })
        .optional(),
    }),
  },
});

/** Fumadocs collection of published Markdown and MDX blog posts. */
export const blogSource = loader({
  baseUrl: blogRoute,
  source: blog.toFumadocsSource(),
});

/** Published posts in descending date order, with the latest first. */
export function getBlogPosts() {
  return publishedFirst(blogSource.getPages());
}

/** Resolve a post by its public URL slug. */
export function getBlogPost(slug: string) {
  return blogSource.getPage([slug]);
}
